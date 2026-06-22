/**
 * NORIA LLM Layer — model abstraction with multi-key rotation.
 *
 * Provider chain (all free tier):
 *   1. Groq     (llama-3.3-70b-versatile → llama-3.1-8b-instant fallback)
 *   2. Cerebras (llama-3.3-70b → llama3.1-8b fallback) — 1M tokens/day free
 *   3. Gemini   (only if GEMINI_ENABLED=true — most free projects have quota 0)
 *   4. Ollama   (local, 100% free)
 *
 * MULTI-KEY ROTATION
 * ──────────────────
 * Supply multiple keys to multiply your daily free capacity at $0:
 *   GROQ_API_KEYS     = key1,key2,key3      (comma-separated)
 *   CEREBRAS_API_KEYS = keyA,keyB
 * The singular GROQ_API_KEY / CEREBRAS_API_KEY are also honoured.
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

// Round-robin cursor so load spreads across keys instead of always hammering #1.
let rotation = 0
function rotate(arr) {
  if (arr.length <= 1) return arr
  const start = rotation++ % arr.length
  return [...arr.slice(start), ...arr.slice(0, start)]
}

const isTokenLimit = (s) => /tokens per day|TPD|tokens per minute|TPM|rate.?limit|RESOURCE_EXHAUSTED|\b429\b/i.test(s)

// ── OpenAI-compatible completion (Groq + Cerebras share this shape) ────────────
async function openAICompatible({ url, key, models, messages, opts }) {
  let lastErr = ''
  for (const model of models) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: opts.maxTokens ?? 1200,
        temperature: opts.temperature ?? 0.4,
        stream: false,
      }),
    })
    if (res.ok) {
      const data = await res.json()
      const text = data.choices?.[0]?.message?.content ?? ''
      if (text.trim()) return text.trim()
      lastErr = `${model}: empty response`
      continue
    }
    const errText = await res.text()
    lastErr = `${model} ${res.status}: ${errText}`
    // Token-limit → try the next (cheaper/higher-quota) model on this key.
    if (res.status === 429 && isTokenLimit(errText)) continue
    // Any other error → stop trying models on this key.
    throw new Error(lastErr)
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
    process.env.CEREBRAS_MODEL || 'llama-3.3-70b',
    process.env.CEREBRAS_FALLBACK_MODEL || 'llama3.1-8b',
  ]
  return openAICompatible({ url: 'https://api.cerebras.ai/v1/chat/completions', key, models, messages, opts })
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

export async function complete(messages, opts = {}) {
  // Build the ordered list of attempts: every Groq key, then every Cerebras key,
  // then optional Gemini, then optional Ollama. Keys are rotated for load spread.
  const attempts = []
  for (const key of rotate(GROQ_KEYS))
    attempts.push({ name: `groq#${GROQ_KEYS.indexOf(key) + 1}`, fn: () => groqComplete(key, messages, opts) })
  for (const key of rotate(CEREBRAS_KEYS))
    attempts.push({ name: `cerebras#${CEREBRAS_KEYS.indexOf(key) + 1}`, fn: () => cerebrasComplete(key, messages, opts) })
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_ENABLED === 'true')
    attempts.push({ name: 'gemini', fn: () => geminiComplete(messages, opts) })
  if (process.env.OLLAMA_BASE_URL || process.env.OLLAMA_MODEL)
    attempts.push({ name: 'ollama', fn: () => ollamaComplete(messages, opts) })

  if (attempts.length === 0)
    throw new Error('No LLM provider configured. Set GROQ_API_KEY(S), CEREBRAS_API_KEY(S), GEMINI_API_KEY, or OLLAMA_BASE_URL.')

  const errors = []
  for (const { name, fn } of attempts) {
    try {
      const text = await fn()
      if (text?.trim()) return text.trim()
      errors.push(`${name}: empty`)
    } catch (e) {
      console.warn('LLM attempt failed:', `${name}: ${e.message}`)
      errors.push(`${name}: ${e.message}`)
      // On a token limit, move straight to the next key/provider (no wait).
      // On other errors, also continue to the next attempt.
    }
  }
  throw new Error('All LLM attempts failed → ' + errors.join(' | '))
}

export function activeProvider() {
  if (GROQ_KEYS.length) return GROQ_KEYS.length > 1 ? `groq (${GROQ_KEYS.length} keys)` : 'groq'
  if (CEREBRAS_KEYS.length) return CEREBRAS_KEYS.length > 1 ? `cerebras (${CEREBRAS_KEYS.length} keys)` : 'cerebras'
  if (process.env.GEMINI_API_KEY) return 'gemini'
  if (process.env.OLLAMA_BASE_URL || process.env.OLLAMA_MODEL) return 'ollama'
  return 'none'
}
