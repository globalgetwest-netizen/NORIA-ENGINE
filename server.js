/**
 * NORIA API Server — standalone AI intelligence engine.
 *
 * Endpoints:
 *   GET  /health             — liveness probe
 *   POST /v1/ask             — main NORIA query endpoint
 *   POST /v1/ingest          — add knowledge (admin, requires NORIA_SETUP_SECRET)
 *   POST /v1/setup           — create schema + seed (admin, requires NORIA_SETUP_SECRET)
 *
 * Any SkyGlobe product (immigration site, future health/finance apps, etc.)
 * calls this single service over HTTP. One brain, many products.
 */

import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { ask } from './engine.js'
import { ingestText } from './ingest.js'
import { setupSchema } from './vectorstore.js'
import { seedKnowledge } from './ingest.js'
import { activeProvider } from './llm.js'

const app = express()
app.use(express.json({ limit: '1mb' }))

// CORS — restrict to your SkyGlobe domains in production via ALLOWED_ORIGINS
const allowed = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim())
app.use(
  cors({
    origin: allowed.includes('*') ? true : allowed,
    methods: ['GET', 'POST'],
  })
)

// ── Simple per-IP rate limiter (in-memory) ────────────────────────────────────
const hits = new Map()
const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 30
app.use((req, res, next) => {
  if (req.path === '/health') return next()
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown'
  const now = Date.now()
  const rec = hits.get(ip) || { count: 0, reset: now + WINDOW_MS }
  if (now > rec.reset) {
    rec.count = 0
    rec.reset = now + WINDOW_MS
  }
  rec.count++
  hits.set(ip, rec)
  if (rec.count > MAX_PER_WINDOW) return res.status(429).json({ error: 'Too many requests. Please slow down.' })
  next()
})

function requireSecret(req, res) {
  const secret = process.env.NORIA_SETUP_SECRET
  if (!secret) return true // no secret configured → allow (dev only)
  if (req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'Unauthorized' })
    return false
  }
  return true
}

// ── LLM test (diagnostic only) ────────────────────────────────────────────────
app.get('/v1/test-llm', async (req, res) => {
  const secret = process.env.NORIA_SETUP_SECRET
  if (secret && req.query.secret !== secret) return res.status(401).send('Unauthorized')
  const results = {}
  // Test 1: raw LLM
  try {
    const { complete } = await import('./llm.js')
    const text = await complete([{ role: 'user', content: 'Say: NORIA LLM OK' }], { maxTokens: 20 })
    results.llm = { ok: true, response: text }
  } catch (e) {
    results.llm = { ok: false, error: e.message }
  }
  // Test 2: embed
  try {
    const { embed } = await import('./embedder.js')
    const vec = await embed('test')
    results.embed = { ok: true, dims: vec?.length }
  } catch (e) {
    results.embed = { ok: false, error: e.message }
  }
  // Test 3: full ask()
  try {
    const testQuery = req.query.q ? String(req.query.q) : 'Hello, are you working?'
    const result = await ask(testQuery, [])
    results.ask = { ok: true, query: testQuery, answer: result.answer?.slice(0, 200), provider: result.provider, llmError: result.llmError, webResults: result.webResults, retrievedDocs: result.retrievedDocs }
  } catch (e) {
    results.ask = { ok: false, error: e.message }
  }
  res.json(results)
})

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'noria-engine',
    provider: activeProvider(),
    db: !!process.env.DATABASE_URL,
    // Safe diagnostics — booleans only, NEVER the actual key values
    env: {
      GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
      OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
      OLLAMA_BASE_URL: !!process.env.OLLAMA_BASE_URL,
      GROQ_API_KEY: !!process.env.GROQ_API_KEY,
      DATABASE_URL: !!process.env.DATABASE_URL,
      NORIA_SETUP_SECRET: !!process.env.NORIA_SETUP_SECRET,
    },
    time: new Date().toISOString(),
  })
})

// ── Main query endpoint ─────────────────────────────────────────────────────
app.post('/v1/ask', async (req, res) => {
  try {
    const query = String(req.body?.query ?? req.body?.message ?? '').trim()
    if (!query) return res.status(400).json({ error: 'query is required' })
    if (query.length > 2000) return res.status(400).json({ error: 'query too long (max 2000 chars)' })

    const rawHistory = Array.isArray(req.body?.history) ? req.body.history.slice(-10) : []
    const history = rawHistory
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: String(m.content) }))

    const result = await ask(query, history)
    res.json(result)
  } catch (e) {
    console.error('/v1/ask error:', e)
    res.json({
      answer:
        'NORIA is temporarily unavailable. Please try again shortly or contact support@skyglobegroup.com.',
      sources: [],
    })
  }
})

// ── Admin: ingest knowledge ──────────────────────────────────────────────────
app.post('/v1/ingest', async (req, res) => {
  if (!requireSecret(req, res)) return
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'DATABASE_URL not configured' })
  try {
    const source = String(req.body?.source ?? '').trim()
    const content = String(req.body?.content ?? '').trim()
    if (!source || !content) return res.status(400).json({ error: 'source and content are required' })
    const chunks = await ingestText(source, content, req.body?.metadata ?? {})
    res.json({ ok: true, source, chunks })
  } catch (e) {
    console.error('/v1/ingest error:', e)
    res.status(500).json({ error: e.message })
  }
})

// ── Admin: setup schema + seed ───────────────────────────────────────────────
app.post('/v1/setup', async (req, res) => {
  if (!requireSecret(req, res)) return
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'DATABASE_URL not configured' })
  try {
    await setupSchema()
    await seedKnowledge()
    res.json({ ok: true, message: 'NORIA schema created and seed knowledge ingested.' })
  } catch (e) {
    console.error('/v1/setup error:', e)
    res.status(500).json({ error: e.message })
  }
})

// ── Admin: setup via browser (GET with ?secret=...) ──────────────────────────
// Lets you run setup by pasting a URL in your browser address bar.
app.get('/v1/setup', async (req, res) => {
  const secret = process.env.NORIA_SETUP_SECRET
  if (secret && req.query.secret !== secret) {
    return res.status(401).send('Unauthorized — wrong or missing ?secret=')
  }
  if (!process.env.DATABASE_URL) return res.status(503).send('DATABASE_URL not configured')
  try {
    await setupSchema()
    await seedKnowledge()
    res.send('✅ NORIA setup complete — schema created and all knowledge (Africa + SkyGlobe) ingested into the database. You can close this tab.')
  } catch (e) {
    console.error('/v1/setup (GET) error:', e)
    res.status(500).send('Setup failed: ' + e.message)
  }
})

const PORT = process.env.PORT || 4000
app.listen(PORT, () => {
  console.log(`NORIA engine listening on :${PORT} — provider=${activeProvider()} db=${!!process.env.DATABASE_URL}`)
})
