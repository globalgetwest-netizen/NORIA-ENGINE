/**
 * NORIA Billing — the "Pro" subscription, billed weekly or monthly, through
 * either Paystack (cards / mobile money / bank / USSD — best for Africa) or
 * Paddle (cards / wallets globally — Paddle is merchant-of-record so it
 * handles VAT/sales tax for you). Both providers are optional and independent:
 * configure one, the other, or both — whichever has keys set is offered.
 *
 * Flow (Paystack):
 *   1. Signed-in user POSTs /v1/billing/subscribe { interval: 'weekly'|'monthly' }.
 *      We start a Paystack transaction against the matching Plan code. Paystack
 *      returns an authorization_url → the frontend redirects the user there.
 *      Because a plan is attached, a recurring subscription is created on success.
 *   2. Paystack calls /v1/billing/webhook/paystack for every event. We verify
 *      the HMAC-SHA512 signature, then activate / renew / deactivate the sub.
 *
 * Flow (Paddle):
 *   1. The frontend calls /v1/billing/config to get the public Paddle client
 *      token + price IDs, then opens Paddle.js's checkout overlay directly
 *      (Paddle.Checkout.open) with the chosen price and `customData:
 *      { user_id }`. No server call needed to start a Paddle checkout.
 *   2. Paddle calls /v1/billing/webhook/paddle for every event. We verify the
 *      `Paddle-Signature` header, then activate / renew / deactivate the sub.
 *
 * In both cases: requireActiveSubscription() gates the AI endpoints, and
 * entitlement is only ever granted by a verified webhook — never by the
 * browser — so a user cannot self-activate.
 *
 * Env:
 *   PAYSTACK_SECRET_KEY / PAYSTACK_PUBLIC_KEY   — sk_/pk_… (server secret / public)
 *   PAYSTACK_PLAN_PRO_WEEKLY / _MONTHLY         — Paystack Plan codes (PLN_…)
 *   PADDLE_API_KEY                              — server-side Paddle API key
 *   PADDLE_CLIENT_TOKEN                         — public token for Paddle.js
 *   PADDLE_WEBHOOK_SECRET                       — signs /v1/billing/webhook/paddle
 *   PADDLE_ENVIRONMENT                          — 'sandbox' (default) | 'production'
 *   PADDLE_PRICE_PRO_WEEKLY / _MONTHLY          — Paddle Price IDs (pri_…)
 *   PAYWALL_ENABLED                             — 'true' to enforce the paywall
 *   PAYWALL_CALLBACK_URL                        — where Paystack returns the user
 */

import express from 'express'
import crypto from 'crypto'
import { getPool } from './db.js'
import { requireAuth } from './auth.js'

// ── Config ───────────────────────────────────────────────────────────────────
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || ''
const PAYSTACK_PUBLIC = process.env.PAYSTACK_PUBLIC_KEY || ''

const PADDLE_API_KEY = process.env.PADDLE_API_KEY || ''
const PADDLE_CLIENT_TOKEN = process.env.PADDLE_CLIENT_TOKEN || ''
const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET || ''
const PADDLE_ENV = (process.env.PADDLE_ENVIRONMENT || 'sandbox').toLowerCase()
const PADDLE_API_BASE = PADDLE_ENV === 'production' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com'

// NORIA Pro is the only tier today: one plan, two billing intervals.
// Each interval needs its own Plan (Paystack) / Price (Paddle) created in the
// provider's dashboard — see MONETIZATION.md for the exact click-through steps.
export const PLAN_PRICES = {
  weekly: {
    amountUSD: 10,
    label: 'Weekly',
    paystackPlan: process.env.PAYSTACK_PLAN_PRO_WEEKLY || '',
    paddlePriceId: process.env.PADDLE_PRICE_PRO_WEEKLY || '',
  },
  monthly: {
    amountUSD: 25,
    label: 'Monthly',
    paystackPlan: process.env.PAYSTACK_PLAN_PRO_MONTHLY || '',
    paddlePriceId: process.env.PADDLE_PRICE_PRO_MONTHLY || '',
  },
}

// ── Live-editable pricing (admin) ──────────────────────────────────────────
// PLAN_PRICES above holds the .env defaults. On boot (and after every /v1/setup)
// we overlay any saved overrides from Postgres, so a price change made from
// the CEO/admin panel takes effect everywhere instantly — no redeploy, no code
// edit — because every route below reads PLAN_PRICES by reference.
//
// Note on what this actually changes: the *displayed* amount (amountUSD) is
// free to set to anything. The amount actually *charged* is still whatever
// the referenced Paystack Plan / Paddle Price is configured for in that
// provider's own dashboard — that is an industry-wide constraint of recurring
// billing (Paystack/Paddle/Stripe all require a pre-created Plan/Price object
// for subscriptions). So a genuine price change is two steps: create the new
// Plan/Price in the provider dashboard, then paste its code/id — and the
// matching display amount — into the admin panel here. No code touched.
export async function setupBillingSchema() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS noria_plan_pricing (
      interval        TEXT PRIMARY KEY,
      amount_usd      NUMERIC,
      paystack_plan   TEXT,
      paddle_price_id TEXT,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
}

export async function loadPlanPricingOverrides() {
  try {
    const { rows } = await getPool().query('SELECT * FROM noria_plan_pricing')
    for (const row of rows) {
      const p = PLAN_PRICES[row.interval]
      if (!p) continue
      if (row.amount_usd != null) p.amountUSD = Number(row.amount_usd)
      if (row.paystack_plan) p.paystackPlan = row.paystack_plan
      if (row.paddle_price_id) p.paddlePriceId = row.paddle_price_id
    }
    console.log(`✓ NORIA Pro pricing overrides loaded (${rows.length})`)
  } catch (e) {
    console.log('• No NORIA Pro pricing overrides loaded (table missing or empty) — using .env defaults.')
  }
}

// Same bearer-secret pattern as the rest of NORIA's admin routes
// (/v1/ingest, /v1/setup) — also accepts ?secret= for a quick browser check.
function requireAdminSecret(req, res) {
  const secret = process.env.NORIA_SETUP_SECRET
  if (!secret) return true // no secret configured → allow (dev only)
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (bearer === secret || req.query.secret === secret) return true
  res.status(401).json({ error: 'Unauthorized' })
  return false
}

export const paywallEnabled = () => process.env.PAYWALL_ENABLED === 'true'
export const paystackConfigured = () => !!PAYSTACK_SECRET
export const paddleConfigured = () => !!PADDLE_API_KEY && !!PADDLE_CLIENT_TOKEN
export const billingConfigured = () => paystackConfigured() || paddleConfigured()

function intervalFromPaystackPlan(code) {
  if (code && code === PLAN_PRICES.weekly.paystackPlan) return 'weekly'
  if (code && code === PLAN_PRICES.monthly.paystackPlan) return 'monthly'
  return null
}
function intervalFromPaddlePrice(id) {
  if (id && id === PLAN_PRICES.weekly.paddlePriceId) return 'weekly'
  if (id && id === PLAN_PRICES.monthly.paddlePriceId) return 'monthly'
  return null
}

// Kept for compatibility with code that asks "what tier is this user on" — NORIA
// only has the 'pro' tier today, so any active subscription is tier 'pro'.
export function planTier(active) {
  return active ? 'pro' : 'none'
}

async function paystack(path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.paystack.co${path}`, {
    method,
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.status === false) {
    throw new Error(`Paystack ${path} → ${res.status}: ${data.message || 'error'}`)
  }
  return data.data
}

async function paddle(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${PADDLE_API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${PADDLE_API_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`Paddle ${path} → ${res.status}: ${data?.error?.detail || data?.error?.code || 'error'}`)
  }
  return data.data
}

// ── Entitlement ───────────────────────────────────────────────────────────────
// Returns the caller's current entitlement. When the paywall is OFF, everyone is
// treated as entitled so the site works exactly as before until you flip
// PAYWALL_ENABLED=true.
export async function getEntitlement(user) {
  if (!user) {
    return paywallEnabled()
      ? { active: false, plan: 'none', tier: 'none', interval: null, provider: null }
      : { active: true, plan: 'none', tier: 'pro', interval: null, provider: null }
  }
  const { rows } = await getPool().query('SELECT * FROM noria_subscriptions WHERE user_id = $1', [user.id])
  const sub = rows[0]
  const notExpired = sub?.current_period_end ? new Date(sub.current_period_end).getTime() > Date.now() : false
  const active = !!sub && sub.status === 'active' && (notExpired || !sub.current_period_end)
  if (!paywallEnabled()) {
    return { active: true, plan: sub?.plan || 'none', tier: 'pro', interval: sub?.interval || null, provider: sub?.provider || null }
  }
  return {
    active,
    plan: active ? sub.plan || 'pro' : 'none',
    tier: planTier(active),
    interval: sub?.interval || null,
    provider: sub?.provider || null,
    currentPeriodEnd: sub?.current_period_end || null,
  }
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
          error: 'An active NORIA Pro subscription is required to continue.',
          code: 'SUBSCRIPTION_REQUIRED',
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
  const cols = Object.keys(fields).filter((c) => fields[c] !== undefined)
  if (!cols.length) return
  const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ')
  const vals = cols.map((c) => fields[c])
  await getPool().query(
    `INSERT INTO noria_subscriptions (user_id, ${cols.join(', ')}, updated_at)
     VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}, now())
     ON CONFLICT (user_id) DO UPDATE SET ${sets}, updated_at = now()`,
    [userId, ...vals]
  )
}

async function findUserByEmail(email) {
  if (!email) return null
  const { rows } = await getPool().query('SELECT id FROM noria_users WHERE email = $1', [String(email).toLowerCase()])
  return rows[0]?.id || null
}

// ── Router ────────────────────────────────────────────────────────────────────
export function billingRouter() {
  const router = express.Router()

  // What the frontend needs to render the pricing screen for both providers.
  router.get('/config', (_req, res) => {
    res.json({
      configured: billingConfigured(),
      paywallEnabled: paywallEnabled(),
      plan: {
        key: 'pro',
        label: 'NORIA Pro',
        weekly: { usd: PLAN_PRICES.weekly.amountUSD },
        monthly: { usd: PLAN_PRICES.monthly.amountUSD },
      },
      paystack: {
        configured: paystackConfigured(),
        publicKey: PAYSTACK_PUBLIC,
        plans: {
          weekly: PLAN_PRICES.weekly.paystackPlan || null,
          monthly: PLAN_PRICES.monthly.paystackPlan || null,
        },
      },
      paddle: {
        configured: paddleConfigured(),
        clientToken: PADDLE_CLIENT_TOKEN || null,
        environment: PADDLE_ENV,
        prices: {
          weekly: PLAN_PRICES.weekly.paddlePriceId || null,
          monthly: PLAN_PRICES.monthly.paddlePriceId || null,
        },
      },
    })
  })

  // Start a Paystack subscription: returns an authorization_url to redirect to.
  // (Paddle needs no server call — the frontend opens Paddle.js's checkout
  // overlay directly using the price IDs from /config.)
  router.post('/subscribe', requireAuth, async (req, res) => {
    try {
      if (!paystackConfigured()) return res.status(503).json({ error: 'Paystack is not configured yet.' })
      const interval = String(req.body?.interval || 'monthly').toLowerCase()
      const price = PLAN_PRICES[interval]
      if (!price) return res.status(400).json({ error: 'interval must be "weekly" or "monthly".' })
      if (!price.paystackPlan) return res.status(503).json({ error: `No Paystack plan configured for ${interval} billing yet.` })
      const data = await paystack('/transaction/initialize', {
        method: 'POST',
        body: {
          email: req.user.email,
          plan: price.paystackPlan,
          callback_url: process.env.PAYWALL_CALLBACK_URL || undefined,
          metadata: { user_id: String(req.user.id), plan: 'pro', interval },
        },
      })
      res.json({ authorizationUrl: data.authorization_url, reference: data.reference, provider: 'paystack' })
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

  // Cancel: works for whichever provider the active subscription is on.
  router.post('/cancel', requireAuth, async (req, res) => {
    try {
      const { rows } = await getPool().query('SELECT * FROM noria_subscriptions WHERE user_id = $1', [req.user.id])
      const sub = rows[0]
      if (!sub || sub.status !== 'active') return res.status(400).json({ error: 'No active subscription to cancel.' })

      if (sub.provider === 'paddle' && sub.paddle_subscription_id) {
        await paddle(`/subscriptions/${sub.paddle_subscription_id}/cancel`, {
          method: 'POST',
          body: { effective_from: 'immediately' },
        })
      } else if (sub.paystack_subscription_code && sub.paystack_email_token) {
        await paystack('/subscription/disable', {
          method: 'POST',
          body: { code: sub.paystack_subscription_code, token: sub.paystack_email_token },
        })
      } else {
        return res.status(400).json({ error: 'No cancellable subscription found for this account.' })
      }
      await upsertSubscription(req.user.id, { status: 'cancelled' })
      res.json({ ok: true })
    } catch (e) {
      console.error('/v1/billing/cancel error:', e)
      res.status(502).json({ error: 'Could not cancel subscription.' })
    }
  })

  // Admin: view live pricing (defaults + any saved overrides already applied).
  router.get('/admin/pricing', (req, res) => {
    if (!requireAdminSecret(req, res)) return
    res.json(PLAN_PRICES)
  })

  // Admin: change NORIA Pro's price for one interval. Takes effect immediately,
  // sitewide, no redeploy. Body: { amountUSD?, paystackPlan?, paddlePriceId? } —
  // only the fields you send are changed. See the note above setupBillingSchema
  // for why amountUSD alone doesn't change what's actually charged.
  router.patch('/admin/pricing/:interval', async (req, res) => {
    if (!requireAdminSecret(req, res)) return
    const interval = req.params.interval
    const entry = PLAN_PRICES[interval]
    if (!entry) return res.status(404).json({ error: 'interval must be "weekly" or "monthly".' })

    const { amountUSD, paystackPlan, paddlePriceId } = req.body || {}
    if (amountUSD != null && !isNaN(amountUSD)) entry.amountUSD = Number(amountUSD)
    if (paystackPlan != null) entry.paystackPlan = String(paystackPlan).trim()
    if (paddlePriceId != null) entry.paddlePriceId = String(paddlePriceId).trim()

    try {
      await getPool().query(
        `INSERT INTO noria_plan_pricing (interval, amount_usd, paystack_plan, paddle_price_id, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (interval) DO UPDATE SET
           amount_usd = $2, paystack_plan = $3, paddle_price_id = $4, updated_at = now()`,
        [interval, entry.amountUSD, entry.paystackPlan || null, entry.paddlePriceId || null]
      )
    } catch (e) {
      console.error('noria_plan_pricing persist failed:', e.message)
      return res.status(500).json({
        error: 'Price updated live, but could not be saved permanently — it will reset on next restart. Run /v1/setup once to create the noria_plan_pricing table.',
      })
    }

    res.json({ ok: true, interval, plan: entry })
  })

  return router
}

// ── Webhooks ──────────────────────────────────────────────────────────────────
// Mounted separately in server.js (before the JSON-parsed routers) so they get
// the RAW body needed to verify each provider's signature. Never trust an event
// whose signature does not match — entitlement is only ever granted here.

export async function handlePaystackWebhook(req, res) {
  try {
    if (!PAYSTACK_SECRET) return res.sendStatus(200)
    const signature = req.headers['x-paystack-signature']
    const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}))
    const expected = crypto.createHmac('sha512', PAYSTACK_SECRET).update(raw).digest('hex')
    if (signature !== expected) {
      console.warn('Paystack webhook: signature mismatch — ignored')
      return res.sendStatus(401)
    }
    const event = req.body?.event
    const data = req.body?.data || {}
    const metaUserId = Number(data?.metadata?.user_id || data?.customer?.metadata?.user_id) || null
    const metaInterval = data?.metadata?.interval || data?.subscription?.metadata?.interval || null

    async function findUserId() {
      if (metaUserId) return metaUserId
      const email = data?.customer?.email || data?.subscription?.customer?.email
      return findUserByEmail(email)
    }

    switch (event) {
      case 'subscription.create': {
        const uid = await findUserId()
        if (uid) {
          const code = data?.plan?.plan_code
          await upsertSubscription(uid, {
            plan: 'pro',
            status: 'active',
            provider: 'paystack',
            interval: intervalFromPaystackPlan(code) || metaInterval || undefined,
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
          const fields = { status: 'active', provider: 'paystack' }
          const next = data?.subscription?.next_payment_date || data?.next_payment_date
          if (next) fields.current_period_end = next
          const code = data?.plan?.plan_code || data?.subscription?.plan?.plan_code
          const interval = intervalFromPaystackPlan(code)
          if (interval) fields.interval = interval
          fields.plan = 'pro'
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

// Backward-compatible alias — earlier versions mounted the Paystack handler at
// the un-suffixed /v1/billing/webhook path. Keep that path working too.
export const handleWebhook = handlePaystackWebhook

export async function handlePaddleWebhook(req, res) {
  try {
    if (!PADDLE_WEBHOOK_SECRET) return res.sendStatus(200)
    const sigHeader = String(req.headers['paddle-signature'] || '')
    const parts = Object.fromEntries(sigHeader.split(';').map((p) => p.split('=')))
    const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}))
    const expected = parts.ts ? crypto.createHmac('sha256', PADDLE_WEBHOOK_SECRET).update(`${parts.ts}:${raw}`).digest('hex') : null
    if (!expected || !parts.h1 || parts.h1 !== expected) {
      console.warn('Paddle webhook: signature mismatch — ignored')
      return res.sendStatus(401)
    }

    const event = req.body?.event_type
    const data = req.body?.data || {}
    const customUserId = Number(data?.custom_data?.user_id) || null
    const priceId = data?.items?.[0]?.price?.id || data?.items?.[0]?.price_id || null
    const interval = intervalFromPaddlePrice(priceId)

    async function findUserId() {
      if (customUserId) return customUserId
      const customerId = data?.customer_id
      if (!customerId || !PADDLE_API_KEY) return null
      try {
        const customer = await paddle(`/customers/${customerId}`)
        return findUserByEmail(customer?.email)
      } catch {
        return null
      }
    }

    switch (event) {
      case 'subscription.created':
      case 'subscription.activated':
      case 'subscription.updated': {
        const uid = await findUserId()
        if (uid) {
          const rawStatus = data?.status
          const status = rawStatus === 'canceled' ? 'cancelled' : rawStatus === 'past_due' ? 'past_due' : 'active'
          const fields = {
            plan: 'pro',
            status,
            provider: 'paddle',
            paddle_subscription_id: data?.id || null,
            paddle_customer_id: data?.customer_id || null,
            current_period_end: data?.current_billing_period?.ends_at || null,
          }
          if (interval) fields.interval = interval
          await upsertSubscription(uid, fields)
        }
        break
      }
      case 'subscription.canceled':
      case 'subscription.paused': {
        const uid = await findUserId()
        if (uid) await upsertSubscription(uid, { status: 'cancelled' })
        break
      }
      case 'transaction.completed': {
        // Safety net in case a subscription event is delayed — only act when we
        // can positively resolve both the user and the interval.
        const uid = await findUserId()
        if (uid && interval && data?.subscription_id) {
          await upsertSubscription(uid, {
            plan: 'pro',
            status: 'active',
            provider: 'paddle',
            interval,
            paddle_subscription_id: data.subscription_id,
            paddle_customer_id: data?.customer_id || null,
          })
        }
        break
      }
      default:
        break
    }
    res.sendStatus(200)
  } catch (e) {
    console.error('Paddle webhook error:', e)
    res.sendStatus(200) // ack anyway so Paddle does not hammer retries
  }
}
