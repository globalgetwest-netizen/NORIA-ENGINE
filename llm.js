/**
 * NORIA LLM Layer — model abstraction with multi-key rotation.
 *
 * Provider chain (all free tier):
 *   1. Groq       (llama-3.3-70b-versatile → llama-3.1-8b-instant fallback)
 *   2. Cerebras   (llama-3.3-70b → llama3.1-8b fallback) — 1M tokens/day free
 *   3. OpenRouter (llama-3.3-70b-instruct:free → fallback free model)
 *   4. Gemini     (only if GEMINI_ENABLED=true — most free projects have quota 0)
 *   5. Ollama     (local, 100% free)
 *
 * MULTI-KEY ROTATION
 * ──────────────────
 * Supply multiple keys to multiply your daily free capacity at $0:
 *   GROQ_API_KEYS       = key1,key2,key3      (comma-separated)
 *   CEREBRAS_API_KEYS   = keyA,keyB
 *   OPENROUTER_API_KEYS = keyX,keyY
 * The singular GROQ_API_KEY / CEREBRAS_API_KEY / OPENROUTER_API_KEY are also honoured.
 *
 * Keys are tried round-robin (load spreads evenly), and when one hits its
 * daily/minute token limit NORIA automatically advances to the next key,
 * then the next provider — so it effectively never goes down.
 */

// ── Key parsing ────────────────────────────────────────────────────────────────
function parseKeys(...envNames) {
  const keys = []
  for (const name of envNames) {
    const v = process.env[name]
    if (v) for (const k of v.split(',').map((s) => s.trim()).filter(Boolean)) if (!keys.includes(k)) keys.push(k)
  }
  return keys
}

const GROQ_KEYS = parseKeys('GROQ_API_KEYS', 'GROQ_API_KEY')
const CEREBRAS_KEYS = parseKeys('CEREBRAS_API_KEYS', 'CEREBRAS_API_KEY')
const OPENROUTER_KEYS = parseKeys('OPENROUTER_API_KEYS', 'OPENROUTER_API_KEY')

// Round-robin cursor so load spreads across keys instead of always hammering #1.
let rotation = 0
function rotate(arr) {
  if (arr.length <= 1) return arr
  const start = rotation++ % arr.length
  return [...arr.slice(start), ...arr.slice(0, start)]
}

const isTokenLimit = (s) => /tokens per day|TPD|tokens per minute|TPM|rate.?limit|RESOURCE_EXHAUSTED|\b429\b/i.test(s)
// Model unavailable: wrong/renamed slug, gated (no access), or no-longer-free.
// On these we should try the NEXT model on the same key, not abandon the key.
const isModelError = (status, s) =>
  status === 404 ||
  /does not exist|do not have access|not found|model_not_found|unavailable for free|no endpoints|not available|decommissioned|invalid model/i.test(s)
// A daily-quota exhaustion (tokens-per-day) — distinct from a short per-minute
// limit. When a key hits its DAILY cap there's no point re-hitting it for a
// while, so we park it on a cooldown and skip it (avoids wasted round-trips and
// the latency they add to every later request).
const isDailyLimit = (s) => /tokens per day|TPD|per day|RESOURCE_EXHAUSTED|quota/i.test(s)
const _cooldown = new Map() // id -> epoch ms until which to skip this key
const onCooldown = (id) => { const t = _cooldown.get(id); return t && Date.now() < t }
function parkCooldown(id, msg, defaultMs = 6 * 60 * 1000) {
  // Honour "try again in 6m2s" if present, else use the default.
  const m = /try again in\s+(?:(\d+)m)?\s*([\d.]+)s/i.exec(msg || '')
  let ms = defaultMs
  if (m) ms = ((Number(m[1]) || 0) * 60 + Math.ceil(Number(m[2]) || 0)) * 1000 + 2000
  _cooldown.set(id, Date.now() + Math.min(ms, 60 * 60 * 1000))
}
// Context-window / payload-too-large errors (e.g. Cerebras free tier = 8192 tokens).
// These are NOT quota errors — retrying the same request won't help, but a smaller
// output budget might let it through, so we handle them distinctly.
const isContextError = (s) =>
  /context (length|window)|maximum context|too (long|large)|reduce (the )?length|max_tokens|please reduce|exceeds? .*(context|token)/i.test(s)

// ── OpenAI-compatible completion (Groq + Cerebras + OpenRouter share this shape) ─
async function openAICompatible({ url, key, models, messages, opts, extraHeaders = {} }) {
  let lastErr = ''
  for (const model of models) {
    // Try the requested output budget first; if the provider rejects it for being
    // too large for its context window, retry once with a smaller budget so a long
    // document still completes on a small-context provider instead of failing.
    for (const maxTokens of [opts.maxTokens ?? 1200, 1500]) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...extraHeaders },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          temperature: opts.temperature ?? 0.3,
          stream: false,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        const text = data.choices?.[0]?.message?.content ?? ''
        if (text.trim()) return text.trim()
        lastErr = `${model}: empty response`
        break // empty → try the next model, not a smaller budget
      }
      const errText = await res.text()
      lastErr = `${model} ${res.status}: ${errText}`
      // Context too large → retry this model once with a smaller output budget.
      if (isContextError(errText) && maxTokens !== 1500) continue
      // Token-limit → move to the next (cheaper/higher-quota) model on this key.
      if (res.status === 429 && isTokenLimit(errText)) break
      // Model missing / not accessible / no-longer-free → try the NEXT model on
      // this key (e.g. fall from a gated 70B to a working 8B) instead of dying.
      if (isModelError(res.status, errText)) break
      // Any other error → stop trying models on this key (caller fails over).
      throw new Error(lastErr)
    }
  }
  throw new Error(lastErr || 'all models exhausted')
}

async function groqComplete(key, messages, opts = {}) {
  const models = [
    process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    process.env.GROQ_FALLBACK_MODEL || 'llama-3.1-8b-instant',
  ]
  return openAICompatible({ url: 'https://api.groq.com/openai/v1/chat/completions', key, models, messages, opts })
}

async function cerebrasComplete(key, messages, opts = {}) {
  const models = [
    process.env.CEREBRAS_MODEL || 'gpt-oss-120b',
    process.env.CEREBRAS_FALLBACK_MODEL || 'zai-glm-4.7',
  ]
  return openAICompatible({ url: 'https://api.cerebras.ai/v1/chat/completions', key, models, messages, opts })
}

async function openRouterComplete(key, messages, opts = {}) {
  const models = [
    process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
    process.env.OPENROUTER_FALLBACK_MODEL || 'meta-llama/llama-3.2-3b-instruct:free',
  ]
  // OpenRouter recommends these headers for free-tier identification/ranking.
  const extraHeaders = {
    'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://noria-engine.onrender.com',
    'X-Title': process.env.OPENROUTER_TITLE || 'Noria',
  }
  return openAICompatible({
    url: 'https://openrouter.ai/api/v1/chat/completions',
    key,
    models,
    messages,
    opts,
    extraHeaders,
  })
}

async function geminiComplete(messages, opts = {}) {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY not set')
  const system = messages.find((m) => m.role === 'system')?.content ?? ''
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite'
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: system ? { parts: [{ text: system }] } : undefined,
        contents,
        generationConfig: { maxOutputTokens: opts.maxTokens ?? 1200, temperature: opts.temperature ?? 0.4 },
      }),
    }
  )
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`)
  const data = await res.json()
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
}

async function ollamaComplete(messages, opts = {}) {
  const base = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434'
  const model = process.env.OLLAMA_MODEL ?? 'llama3'
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, options: { num_predict: opts.maxTokens ?? 1200 } }),
  })
  if (!res.ok) throw new Error(`Ollama error ${res.status}`)
  const data = await res.json()
  return data.message?.content ?? ''
}

// ── Streaming (Server-Sent Events) ───────────────────────────────────────────
// OpenAI-compatible providers (Groq, Cerebras, OpenRouter) all stream tokens as
// SSE lines: `data: {json}` with a delta in choices[0].delta.content. We parse
// them and emit each token via onToken so the UI can render words as they arrive.
// Once a stream has begun emitting, we COMMIT to it (return what we have on a
// mid-stream error) so we never re-emit duplicate text from a retry.
async function openAICompatibleStream({ url, key, models, messages, opts, extraHeaders = {} }, onToken) {
  let lastErr = ''
  for (const model of models) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...extraHeaders },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: opts.maxTokens ?? 1200,
        temperature: opts.temperature ?? 0.3,
        stream: true,
      }),
    })
    if (!res.ok) {
      const errText = await res.text()
      lastErr = `${model} ${res.status}: ${errText}`
      if (res.status === 429 && isTokenLimit(errText)) continue // next model on this key
      if (isModelError(res.status, errText)) continue // gated/renamed model → next model
      throw new Error(lastErr) // other error → caller fails over to next key/provider
    }
    // Stream the body. From here we are committed to this attempt.
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = '', full = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') return full
          try {
            const json = JSON.parse(data)
            const delta = json.choices?.[0]?.delta?.content || ''
            if (delta) { full += delta; onToken(delta) }
          } catch (_) { /* ignore keep-alive / partial lines */ }
        }
      }
    } catch (e) {
      if (full.trim()) return full // mid-stream drop → keep what we have
      lastErr = `${model}: stream error ${e.message}`
      throw new Error(lastErr)
    }
    if (full.trim()) return full
    lastErr = `${model}: empty stream`
  }
  throw new Error(lastErr || 'all models exhausted')
}

export async function completeStream(messages, opts = {}, onToken = () => {}) {
  const all = []
  for (const key of rotate(GROQ_KEYS))
    all.push({ id: `groq:${key}`, name: `groq#${GROQ_KEYS.indexOf(key) + 1}`, fn: () => openAICompatibleStream({ url: 'https://api.groq.com/openai/v1/chat/completions', key, models: [process.env.GROQ_MODEL || 'llama-3.3-70b-versatile', process.env.GROQ_FALLBACK_MODEL || 'llama-3.1-8b-instant'], messages, opts }, onToken) })
  for (const key of rotate(CEREBRAS_KEYS))
    all.push({ id: `cerebras:${key}`, name: `cerebras#${CEREBRAS_KEYS.indexOf(key) + 1}`, fn: () => openAICompatibleStream({ url: 'https://api.cerebras.ai/v1/chat/completions', key, models: [process.env.CEREBRAS_MODEL || 'gpt-oss-120b', process.env.CEREBRAS_FALLBACK_MODEL || 'zai-glm-4.7'], messages, opts }, onToken) })
  for (const key of rotate(OPENROUTER_KEYS))
    all.push({ id: `openrouter:${key}`, name: `openrouter#${OPENROUTER_KEYS.indexOf(key) + 1}`, fn: () => openAICompatibleStream({ url: 'https://openrouter.ai/api/v1/chat/completions', key, models: [process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free', process.env.OPENROUTER_FALLBACK_MODEL || 'meta-llama/llama-3.2-3b-instruct:free'], messages, opts, extraHeaders: { 'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://noria-engine.onrender.com', 'X-Title': process.env.OPENROUTER_TITLE || 'Noria' } }, onToken) })

  const live = all.filter((a) => !onCooldown(a.id))
  const queue = live.length ? live : all
  const errors = []
  for (const { id, name, fn } of queue) {
    try {
      const text = await fn()
      if (text?.trim()) return text.trim()
      errors.push(`${name}: empty`)
    } catch (e) {
      if (isDailyLimit(e.message)) parkCooldown(id, e.message)
      else if (isModelError(0, e.message)) parkCooldown(id, e.message, 30 * 60 * 1000)
      console.warn('LLM stream attempt failed:', `${name}: ${e.message}`)
      errors.push(`${name}: ${e.message}`)
    }
  }
  // Last resort — non-streaming providers (Gemini/Ollama) or any remaining path.
  // Emit the whole answer as one chunk so the caller still gets a result.
  const text = await complete(messages, opts)
  if (text?.trim()) { onToken(text); return text.trim() }
  throw new Error('All streaming attempts failed → ' + errors.join(' | '))
}

export async function complete(messages, opts = {}) {
  // Build the ordered list of attempts: every Groq key, then every Cerebras key,
  // then every OpenRouter key, then optional Gemini, then optional Ollama.
  // Keys are rotated for load spread.
  const all = []
  for (const key of rotate(GROQ_KEYS))
    all.push({ id: `groq:${key}`, name: `groq#${GROQ_KEYS.indexOf(key) + 1}`, fn: () => groqComplete(key, messages, opts) })
  for (const key of rotate(CEREBRAS_KEYS))
    all.push({ id: `cerebras:${key}`, name: `cerebras#${CEREBRAS_KEYS.indexOf(key) + 1}`, fn: () => cerebrasComplete(key, messages, opts) })
  for (const key of rotate(OPENROUTER_KEYS))
    all.push({ id: `openrouter:${key}`, name: `openrouter#${OPENROUTER_KEYS.indexOf(key) + 1}`, fn: () => openRouterComplete(key, messages, opts) })
  // Gemini is now ON by default whenever a key exists (set GEMINI_ENABLED=false
  // to disable). Google's free tier is far more generous than Groq's per-minute
  // cap, so this is real, reliable capacity — used as a fallback after the fast
  // OpenAI-compatible providers.
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_ENABLED !== 'false')
    all.push({ id: 'gemini', name: 'gemini', fn: () => geminiComplete(messages, opts) })
  if (process.env.OLLAMA_BASE_URL || process.env.OLLAMA_MODEL)
    all.push({ id: 'ollama', name: 'ollama', fn: () => ollamaComplete(messages, opts) })

  if (all.length === 0)
    throw new Error('No LLM provider configured. Set GROQ_API_KEY(S), CEREBRAS_API_KEY(S), OPENROUTER_API_KEY(S), GEMINI_API_KEY, or OLLAMA_BASE_URL.')

  // Skip keys parked on a daily-limit cooldown — but if that would skip
  // everything, fall back to trying them all (better to attempt than refuse).
  const attempts = all.filter((a) => !onCooldown(a.id))
  const queue = attempts.length ? attempts : all

  const errors = []
  for (const { id, name, fn } of queue) {
    try {
      const text = await fn()
      if (text?.trim()) return text.trim()
      errors.push(`${name}: empty`)
    } catch (e) {
      console.warn('LLM attempt failed:', `${name}: ${e.message}`)
      errors.push(`${name}: ${e.message}`)
      if (isDailyLimit(e.message)) parkCooldown(id, e.message) // exhausted → skip a while
      else if (isModelError(0, e.message)) parkCooldown(id, e.message, 30 * 60 * 1000) // no model access → skip 30m
    }
  }
  throw new Error('All LLM attempts failed → ' + errors.join(' | '))
}

export function activeProvider() {
  if (GROQ_KEYS.length) return GROQ_KEYS.length > 1 ? `groq (${GROQ_KEYS.length} keys)` : 'groq'
  if (CEREBRAS_KEYS.length) return CEREBRAS_KEYS.length > 1 ? `cerebras (${CEREBRAS_KEYS.length} keys)` : 'cerebras'
  if (OPENROUTER_KEYS.length) return OPENROUTER_KEYS.length > 1 ? `openrouter (${OPENROUTER_KEYS.length} keys)` : 'openrouter'
  if (process.env.GEMINI_API_KEY) return 'gemini'
  if (process.env.OLLAMA_BASE_URL || process.env.OLLAMA_MODEL) return 'ollama'
  return 'none'
}
