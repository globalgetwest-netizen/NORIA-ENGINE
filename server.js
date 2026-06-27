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
import { ask, askStream } from './engine.js'
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
// IMPORTANT: many real users share ONE public IP via carrier-grade NAT (very
// common on mobile networks worldwide). A strict per-IP cap therefore blocks
// large groups of legitimate users at once. The cap is kept generous and is the
// configurable RATE_LIMIT_PER_MIN env var; health/diagnostic paths are exempt.
const hits = new Map()
const WINDOW_MS = 60_000
const MAX_PER_WINDOW = Number(process.env.RATE_LIMIT_PER_MIN) || 200
const RATE_EXEMPT = new Set(['/health', '/v1/test-llm', '/v1/test-cerebras', '/v1/feedback', '/v1/cache-stats', '/v1/test-search'])
app.use((req, res, next) => {
  if (RATE_EXEMPT.has(req.path)) return next()
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

// ── Answer feedback (👍/👎) ───────────────────────────────────────────────────
// The frontend posts a rating per answer. We log it (visible in Render logs,
// which persist) and keep the recent ones in memory so you can review what users
// marked inaccurate and ingest corrections. No DB schema change required.
const feedbackLog = [] // ring buffer, newest last (max 200)
app.post('/v1/feedback', (req, res) => {
  const rating = String(req.body?.rating || '')
  if (rating !== 'up' && rating !== 'down') return res.status(400).json({ error: "rating must be 'up' or 'down'" })
  const entry = {
    rating,
    question: String(req.body?.question || '').slice(0, 2000),
    answer: String(req.body?.answer || '').slice(0, 2000),
    at: new Date().toISOString(),
  }
  feedbackLog.push(entry)
  if (feedbackLog.length > 200) feedbackLog.shift()
  console.log(JSON.stringify({ event: 'noria_feedback', rating, question: entry.question.slice(0, 120) }))
  res.json({ ok: true })
})
// Review recent feedback (esp. the 👎 ones) so you can correct/ingest them.
// Open in a browser: /v1/feedback?secret=YOUR_SECRET   (add &rating=down to filter)
app.get('/v1/feedback', (req, res) => {
  const secret = process.env.NORIA_SETUP_SECRET
  if (secret && req.query.secret !== secret) return res.status(401).send('Unauthorized — add ?secret=YOUR_NORIA_SETUP_SECRET')
  const only = req.query.rating
  const items = only ? feedbackLog.filter((f) => f.rating === only) : feedbackLog
  res.json({ count: items.length, feedback: items.slice().reverse() })
})

// ── Cerebras key/model diagnostic ─────────────────────────────────────────────
// Open in a browser: /v1/test-cerebras?secret=YOUR_NORIA_SETUP_SECRET
// For each Cerebras key it asks Cerebras which models that key can actually use,
// so we know the exact working model name (no guessing). Never exposes the keys.
app.get('/v1/test-cerebras', async (req, res) => {
  const secret = process.env.NORIA_SETUP_SECRET
  if (secret && req.query.secret !== secret) return res.status(401).send('Unauthorized — add ?secret=YOUR_NORIA_SETUP_SECRET')
  const keys = (process.env.CEREBRAS_API_KEYS || process.env.CEREBRAS_API_KEY || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
  if (!keys.length) return res.json({ error: 'No CEREBRAS_API_KEYS / CEREBRAS_API_KEY set' })
  const out = []
  for (let i = 0; i < keys.length; i++) {
    try {
      const r = await fetch('https://api.cerebras.ai/v1/models', {
        headers: { Authorization: `Bearer ${keys[i]}` },
      })
      const text = await r.text()
      let models = null
      try { models = JSON.parse(text)?.data?.map((m) => m.id) } catch (_) {}
      out.push({ key: `cerebras#${i + 1}`, httpStatus: r.status, availableModels: models || text.slice(0, 300) })
    } catch (e) {
      out.push({ key: `cerebras#${i + 1}`, error: e.message })
    }
  }
  res.json({
    hint: 'If availableModels lists model ids, set CEREBRAS_MODEL in Render to one of them. If httpStatus is 401, the key is invalid. If 403/empty, the account lacks inference access.',
    keys: out,
  })
})

// ── Live-search diagnostic ────────────────────────────────────────────────────
// Open in a browser: /v1/test-search?secret=YOUR_SECRET (optional &q=...)
// Shows which search providers your keys enable, and a live sample result.
app.get('/v1/test-search', async (req, res) => {
  const secret = process.env.NORIA_SETUP_SECRET
  if (secret && req.query.secret !== secret) return res.status(401).send('Unauthorized — add ?secret=YOUR_NORIA_SETUP_SECRET')
  try {
    const { searchProviders, webSearch, needsLiveSearch } = await import('./searcher.js')
    const q = req.query.q ? String(req.query.q) : 'current price of bitcoin today'
    const results = await webSearch(q)
    res.json({
      query: q,
      triggersLiveSearch: needsLiveSearch(q),
      providersConfigured: searchProviders(),
      resultCount: results.length,
      results: results.slice(0, 4),
      hint: 'If providersConfigured shows all false except duckduckgo, your API keys are set under different env-var names. If resultCount is 0, the search returned nothing for this query.',
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Cache stats ───────────────────────────────────────────────────────────────
// Open in a browser: /v1/cache-stats  → shows how many answers are cached and
// the hit rate (higher hit rate = more free capacity + faster responses).
app.get('/v1/cache-stats', async (req, res) => {
  try {
    const { cacheStats } = await import('./cache.js')
    res.json(cacheStats())
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
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
      GROQ_API_KEY: !!(process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY),
      CEREBRAS_API_KEY: !!(process.env.CEREBRAS_API_KEYS || process.env.CEREBRAS_API_KEY),
      OPENROUTER_API_KEY: !!(process.env.OPENROUTER_API_KEYS || process.env.OPENROUTER_API_KEY),
      DATABASE_URL: !!process.env.DATABASE_URL,
      NORIA_SETUP_SECRET: !!process.env.NORIA_SETUP_SECRET,
    },
    time: new Date().toISOString(),
  })
})

// ── Secure temporary image hosting (for image-to-image) ──────────────────────
// A user's uploaded photo never goes to any third-party host. It is stored
// briefly IN MEMORY here, on YOUR own engine, served at a private URL just long
// enough for the image model to read it once, then auto-deleted. Nothing is
// written to disk and nothing persists past the TTL or a restart.
const imageStore = new Map() // id -> { buf, type, expires }
const IMAGE_TTL_MS = 10 * 60 * 1000 // 10 minutes — plenty for one generation

// Periodically purge expired uploads so memory stays clean.
setInterval(() => {
  const now = Date.now()
  for (const [id, rec] of imageStore) if (rec.expires < now) imageStore.delete(id)
}, 60 * 1000).unref?.()

function publicBase(req) {
  // Render provides RENDER_EXTERNAL_URL automatically; otherwise derive from request.
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '')
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '')
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0]
  return `${proto}://${req.headers.host}`
}

// Upload: accepts a data URL or raw base64; returns a short-lived private URL.
app.post('/v1/upload-image', express.json({ limit: '12mb' }), (req, res) => {
  try {
    const raw = String(req.body?.image || '')
    if (!raw) return res.status(400).json({ error: 'image is required' })
    const m = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/)
    const type = m ? m[1] : 'image/png'
    const b64 = m ? m[2] : raw
    const buf = Buffer.from(b64, 'base64')
    if (!buf.length || buf.length > 12 * 1024 * 1024) return res.status(400).json({ error: 'invalid or oversized image' })
    // Simple unique id without external deps.
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36)
    imageStore.set(id, { buf, type, expires: Date.now() + IMAGE_TTL_MS })
    res.json({ url: `${publicBase(req)}/img/${id}`, expiresInMs: IMAGE_TTL_MS })
  } catch (e) {
    console.error('/v1/upload-image error:', e)
    res.status(500).json({ error: 'upload failed' })
  }
})

// Serve a temporary image by id (used once by the image model, then it expires).
app.get('/img/:id', (req, res) => {
  const rec = imageStore.get(req.params.id)
  if (!rec || rec.expires < Date.now()) return res.status(404).send('Not found')
  res.set('Content-Type', rec.type)
  res.set('Cache-Control', 'public, max-age=600')
  res.send(rec.buf)
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

    // THE FIX: forward the system prompt sent by the frontend so Noria's full
    // identity, language law, and writing rules actually reach the model.
    const system = typeof req.body?.system === 'string' ? req.body.system : ''

    const result = await ask(query, history, system)
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

// ── Streaming query (Server-Sent Events) ─────────────────────────────────────
// Emits: {token:"..."} per chunk, then a final {done:true, sources, provider}.
// On failure: {error:true, answer:"..."}. The frontend renders tokens live.
app.post('/v1/ask/stream', async (req, res) => {
  const query = String(req.body?.query ?? req.body?.message ?? '').trim()
  if (!query) return res.status(400).json({ error: 'query is required' })
  if (query.length > 2000) return res.status(400).json({ error: 'query too long (max 2000 chars)' })

  const rawHistory = Array.isArray(req.body?.history) ? req.body.history.slice(-10) : []
  const history = rawHistory
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: String(m.content) }))
  const system = typeof req.body?.system === 'string' ? req.body.system : ''

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no') // disable proxy buffering so tokens flush
  res.setHeader('Content-Encoding', 'identity') // never gzip — compression buffers SSE
  if (res.flushHeaders) res.flushHeaders()

  const send = (obj) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`)
    if (typeof res.flush === 'function') res.flush() // push bytes out immediately
  }

  // Prime the connection right away + a heartbeat so proxies don't buffer and
  // the client's first-token watchdog sees activity immediately.
  res.write(': open\n\n')
  if (typeof res.flush === 'function') res.flush()
  const heartbeat = setInterval(() => { try { res.write(': hb\n\n'); if (res.flush) res.flush() } catch (_) {} }, 15000)

  try {
    const result = await askStream(query, history, system, (token) => send({ token }))
    send({ done: true, sources: result.sources || [], provider: result.provider })
    clearInterval(heartbeat)
    res.end()
  } catch (e) {
    clearInterval(heartbeat)
    console.error('/v1/ask/stream error:', e)
    send({ error: true, answer: 'Noria is momentarily unavailable. Please try again in a few seconds.' })
    res.end()
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
