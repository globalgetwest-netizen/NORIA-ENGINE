/**
 * NORIA Billing — Paystack monthly subscriptions.
 *
 * Flow:
 *   1. User (authenticated) POSTs /v1/billing/subscribe { plan: 'pro' | 'premium' }.
 *      We ask Paystack to initialize a transaction against the matching PLAN code.
 *      Paystack returns an authorization_url → the frontend redirects the user
 *      there to pay (card / mobile money / bank / USSD). Because a plan is
 *      attached, a recurring subscription is created automatically on success.
 *   2. Paystack calls our /v1/billing/webhook for every event (charge.success,
 *      subscription.create, invoice.*, subscription.disable). We verify the
 *      signature, then activate / renew / deactivate the user's subscription.
 *   3. requireActiveSubscription() gates the AI endpoints.
 *
 * Env:
 *   PAYSTACK_SECRET_KEY     — sk_live_… / sk_test_…  (server-side only, secret)
 *   PAYSTACK_PUBLIC_KEY     — pk_… (returned to the frontend for inline checkout)
 *   PAYSTACK_PLAN_PRO       — plan code (PLN_…) for the Pro tier
 *   PAYSTACK_PLAN_PREMIUM   — plan code (PLN_…) for the Premium tier
 *   PAYWALL_ENABLED         — 'true' to enforce the paywall on AI endpoints
 *   PAYWALL_CALLBACK_URL    — where Paystack returns the user after payment
 */

import express from 'express'
import crypto from 'crypto'
import { getPool } from './db.js'
import { requireAuth } from './auth.js'

const SECRET = process.env.PAYSTACK_SECRET_KEY || ''
const PUBLIC = process.env.PAYSTACK_PUBLIC_KEY || ''
const PLANS = {
  pro: process.env.PAYSTACK_PLAN_PRO || '',
  premium: process.env.PAYSTACK_PLAN_PREMIUM || '',
}

export const paywallEnabled = () => process.env.PAYWALL_ENABLED === 'true'
export const billingConfigured = () => !!SECRET

// Which plans count as premium-model access (used by the engine to pick models).
export function planTier(plan) {
  if (plan === 'premium') return 'premium'
  if (plan === 'pro') return 'pro'
  return 'none'
}

async function paystack(path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.paystack.co${path}`, {
    method,
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.status === false) {
    throw new Error(`Paystack ${path} → ${res.status}: ${data.message || 'error'}`)
  }
  return data.data
}

// ── Entitlement ───────────────────────────────────────────────────────────────
// Returns the caller's current entitlement. When the paywall is OFF, everyone is
// treated as entitled (tier follows their plan if any, else 'pro') so the site
// works exactly as before until you flip PAYWALL_ENABLED=true.
export async function getEntitlement(user) {
  if (!user) {
    return paywallEnabled() ? { active: false, plan: 'none', tier: 'none' } : { active: true, plan: 'none', tier: 'pro' }
  }
  const { rows } = await getPool().query('SELECT * FROM noria_subscriptions WHERE user_id = $1', [user.id])
  const sub = rows[0]
  const notExpired = sub?.current_period_end ? new Date(sub.current_period_end).getTime() > Date.now() : false
  const active = !!sub && sub.status === 'active' && (notExpired || !sub.current_period_end)
  if (!paywallEnabled()) return { active: true, plan: sub?.plan || 'none', tier: planTier(sub?.plan) === 'none' ? 'pro' : planTier(sub?.plan) }
  return { active, plan: sub?.plan || 'none', tier: active ? planTier(sub?.plan) : 'none' }
}

// Middleware: block AI endpoints unless the caller has an active subscription.
export function requireActiveSubscription() {
  return async (req, res, next) => {
    if (!paywallEnabled()) return next() // paywall off → open access (current behaviour)
    if (!req.user) return res.status(401).json({ error: 'Sign in required.', code: 'AUTH_REQUIRED' })
    try {
      const ent = await getEntitlement(req.user)
      if (!ent.active) {
        return res.status(402).json({
          error: 'An active NORIA subscription is required to continue.',
          code: 'SUBSCRIPTION_REQUIRED',
          plans: Object.keys(PLANS).filter((k) => PLANS[k]),
        })
      }
      req.entitlement = ent
      next()
    } catch (e) {
      console.error('subscription check error:', e)
      res.status(500).json({ error: 'Could not verify subscription.' })
    }
  }
}

async function upsertSubscription(userId, fields) {
  const cols = Object.keys(fields)
  const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ')
  const vals = cols.map((c) => fields[c])
  await getPool().query(
    `INSERT INTO noria_subscriptions (user_id, ${cols.join(', ')}, updated_at)
     VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}, now())
     ON CONFLICT (user_id) DO UPDATE SET ${sets}, updated_at = now()`,
    [userId, ...vals]
  )
}

// ── Router ────────────────────────────────────────────────────────────────────
export function billingRouter() {
  const router = express.Router()

  // What the frontend needs to render the pricing screen.
  router.get('/config', (_req, res) => {
    res.json({
      configured: billingConfigured(),
      paywallEnabled: paywallEnabled(),
      publicKey: PUBLIC,
      plans: Object.keys(PLANS).filter((k) => PLANS[k]),
    })
  })

  // Start a subscription: returns a Paystack authorization_url to redirect to.
  router.post('/subscribe', requireAuth, async (req, res) => {
    try {
      if (!billingConfigured()) return res.status(503).json({ error: 'Billing is not configured yet.' })
      const plan = String(req.body?.plan || '').toLowerCase()
      const planCode = PLANS[plan]
      if (!planCode) return res.status(400).json({ error: `Unknown plan. Available: ${Object.keys(PLANS).filter((k) => PLANS[k]).join(', ') || 'none configured'}` })
      const data = await paystack('/transaction/initialize', {
        method: 'POST',
        body: {
          email: req.user.email,
          plan: planCode,
          callback_url: process.env.PAYWALL_CALLBACK_URL || undefined,
          metadata: { user_id: String(req.user.id), plan },
        },
      })
      res.json({ authorizationUrl: data.authorization_url, reference: data.reference, accessCode: data.access_code, publicKey: PUBLIC })
    } catch (e) {
      console.error('/v1/billing/subscribe error:', e)
      res.status(502).json({ error: 'Could not start checkout. Please try again.' })
    }
  })

  // Current subscription status for the signed-in user.
  router.get('/status', requireAuth, async (req, res) => {
    const ent = await getEntitlement(req.user)
    res.json(ent)
  })

  // Cancel: disables the Paystack subscription so it does not renew.
  router.post('/cancel', requireAuth, async (req, res) => {
    try {
      const { rows } = await getPool().query('SELECT * FROM noria_subscriptions WHERE user_id = $1', [req.user.id])
      const sub = rows[0]
      if (!sub?.paystack_subscription_code || !sub?.paystack_email_token) {
        return res.status(400).json({ error: 'No active subscription to cancel.' })
      }
      await paystack('/subscription/disable', {
        method: 'POST',
        body: { code: sub.paystack_subscription_code, token: sub.paystack_email_token },
      })
      await upsertSubscription(req.user.id, { status: 'cancelled' })
      res.json({ ok: true })
    } catch (e) {
      console.error('/v1/billing/cancel error:', e)
      res.status(502).json({ error: 'Could not cancel subscription.' })
    }
  })

  return router
}

// ── Webhook ───────────────────────────────────────────────────────────────────
// Mounted separately in server.js so it receives the RAW body needed to verify
// Paystack's signature. Never trust an event whose signature does not match.
export async function handleWebhook(req, res) {
  try {
    if (!SECRET) return res.sendStatus(200)
    const signature = req.headers['x-paystack-signature']
    const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}))
    const expected = crypto.createHmac('sha512', SECRET).update(raw).digest('hex')
    if (signature !== expected) {
      console.warn('Paystack webhook: signature mismatch — ignored')
      return res.sendStatus(401)
    }
    const event = req.body?.event
    const data = req.body?.data || {}
    const userId = Number(data?.metadata?.user_id || data?.customer?.metadata?.user_id) || null
    const planFromCode = (code) => (code === PLANS.premium ? 'premium' : code === PLANS.pro ? 'pro' : null)

    async function findUserId() {
      if (userId) return userId
      const email = data?.customer?.email || data?.subscription?.customer?.email
      if (!email) return null
      const { rows } = await getPool().query('SELECT id FROM noria_users WHERE email = $1', [String(email).toLowerCase()])
      return rows[0]?.id || null
    }

    switch (event) {
      case 'subscription.create': {
        const uid = await findUserId()
        if (uid) {
          await upsertSubscription(uid, {
            plan: planFromCode(data?.plan?.plan_code) || 'pro',
            status: 'active',
            paystack_customer_code: data?.customer?.customer_code || null,
            paystack_subscription_code: data?.subscription_code || null,
            paystack_email_token: data?.email_token || null,
            current_period_end: data?.next_payment_date || null,
          })
        }
        break
      }
      case 'charge.success':
      case 'invoice.create':
      case 'invoice.update':
      case 'invoice.payment_success': {
        const uid = await findUserId()
        if (uid) {
          const fields = { status: 'active' }
          const next = data?.subscription?.next_payment_date || data?.next_payment_date
          if (next) fields.current_period_end = next
          const code = data?.plan?.plan_code || data?.subscription?.plan?.plan_code
          if (planFromCode(code)) fields.plan = planFromCode(code)
          await upsertSubscription(uid, fields)
        }
        break
      }
      case 'invoice.payment_failed': {
        const uid = await findUserId()
        if (uid) await upsertSubscription(uid, { status: 'past_due' })
        break
      }
      case 'subscription.disable':
      case 'subscription.not_renew': {
        const uid = await findUserId()
        if (uid) await upsertSubscription(uid, { status: 'cancelled' })
        break
      }
      default:
        break
    }
    res.sendStatus(200)
  } catch (e) {
    console.error('Paystack webhook error:', e)
    res.sendStatus(200) // ack anyway so Paystack does not hammer retries
  }
}
