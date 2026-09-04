/**
 * NORIA Auth — email + password accounts with JWT sessions.
 *
 * Endpoints (mounted under /v1/auth):
 *   POST /register  { email, password, name? }  → { token, user }
 *   POST /login     { email, password }          → { token, user }
 *   GET  /me        (Bearer token)               → { user, subscription }
 *
 * Passwords are hashed with bcrypt (never stored or logged in plain text).
 * Sessions are stateless JWTs signed with JWT_SECRET.
 *
 * Phone/OTP sign-in can be added later without changing this file's shape:
 * add a `phone` + `otp` verification route that issues the same JWT.
 */

import express from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { getPool } from './db.js'

const JWT_SECRET = process.env.JWT_SECRET || process.env.NORIA_SETUP_SECRET || ''
const TOKEN_TTL = process.env.JWT_TTL || '30d'
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

if (!JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET is not set — auth tokens cannot be issued. Set JWT_SECRET in the environment.')
}

// ── Schema ────────────────────────────────────────────────────────────────────
export async function setupAuthSchema() {
  const pool = getPool()
  await pool.query(`
    CREATE TABLE IF NOT EXISTS noria_users (
      id             BIGSERIAL PRIMARY KEY,
      email          TEXT UNIQUE NOT NULL,
      password_hash  TEXT NOT NULL,
      name           TEXT,
      phone          TEXT,
      role           TEXT NOT NULL DEFAULT 'user',
      email_verified BOOLEAN NOT NULL DEFAULT false,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS noria_subscriptions (
      user_id                     BIGINT PRIMARY KEY REFERENCES noria_users(id) ON DELETE CASCADE,
      plan                        TEXT NOT NULL DEFAULT 'none',
      status                      TEXT NOT NULL DEFAULT 'inactive',
      paystack_customer_code      TEXT,
      paystack_subscription_code  TEXT,
      paystack_email_token        TEXT,
      current_period_end          TIMESTAMPTZ,
      created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS noria_sub_status_idx ON noria_subscriptions(status)`)
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sign(user) {
  return jwt.sign({ sub: String(user.id), email: user.email, role: user.role }, JWT_SECRET, { expiresIn: TOKEN_TTL })
}

const publicUser = (u) => ({ id: Number(u.id), email: u.email, name: u.name, role: u.role, emailVerified: u.email_verified })

export async function findUserById(id) {
  const { rows } = await getPool().query('SELECT * FROM noria_users WHERE id = $1', [id])
  return rows[0] || null
}

// ── Middleware ────────────────────────────────────────────────────────────────
// Attaches req.user when a valid Bearer token is present. Does NOT reject on its
// own — pair with requireAuth for endpoints that must be authenticated.
export async function attachUser(req, _res, next) {
  try {
    const h = req.headers.authorization || ''
    const m = h.match(/^Bearer\s+(.+)$/i)
    if (m && JWT_SECRET) {
      const payload = jwt.verify(m[1], JWT_SECRET)
      const user = await findUserById(payload.sub)
      if (user) req.user = user
    }
  } catch (_) { /* invalid/expired token → treated as anonymous */ }
  next()
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.', code: 'AUTH_REQUIRED' })
  next()
}

// ── Router ────────────────────────────────────────────────────────────────────
export function authRouter() {
  const router = express.Router()

  router.post('/register', async (req, res) => {
    try {
      if (!JWT_SECRET) return res.status(503).json({ error: 'Auth not configured (JWT_SECRET missing).' })
      const email = String(req.body?.email || '').trim().toLowerCase()
      const password = String(req.body?.password || '')
      const name = String(req.body?.name || '').trim().slice(0, 120) || null
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email is required.' })
      if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' })

      const hash = await bcrypt.hash(password, 10)
      let rows
      try {
        ({ rows } = await getPool().query(
          `INSERT INTO noria_users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING *`,
          [email, hash, name]
        ))
      } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'An account with that email already exists.' })
        throw e
      }
      const user = rows[0]
      await getPool().query(
        `INSERT INTO noria_subscriptions (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
        [user.id]
      )
      res.json({ token: sign(user), user: publicUser(user) })
    } catch (e) {
      console.error('/v1/auth/register error:', e)
      res.status(500).json({ error: 'Could not create account.' })
    }
  })

  router.post('/login', async (req, res) => {
    try {
      if (!JWT_SECRET) return res.status(503).json({ error: 'Auth not configured (JWT_SECRET missing).' })
      const email = String(req.body?.email || '').trim().toLowerCase()
      const password = String(req.body?.password || '')
      const { rows } = await getPool().query('SELECT * FROM noria_users WHERE email = $1', [email])
      const user = rows[0]
      // Constant-ish behaviour: always run a compare to avoid leaking which emails exist.
      const ok = user ? await bcrypt.compare(password, user.password_hash) : await bcrypt.compare(password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvale')
      if (!user || !ok) return res.status(401).json({ error: 'Incorrect email or password.' })
      res.json({ token: sign(user), user: publicUser(user) })
    } catch (e) {
      console.error('/v1/auth/login error:', e)
      res.status(500).json({ error: 'Could not sign in.' })
    }
  })

  router.get('/me', requireAuth, async (req, res) => {
    const { rows } = await getPool().query('SELECT * FROM noria_subscriptions WHERE user_id = $1', [req.user.id])
    const sub = rows[0] || { plan: 'none', status: 'inactive' }
    res.json({
      user: publicUser(req.user),
      subscription: { plan: sub.plan, status: sub.status, currentPeriodEnd: sub.current_period_end },
    })
  })

  return router
}

export { publicUser }
