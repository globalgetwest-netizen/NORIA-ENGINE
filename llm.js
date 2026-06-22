/**
 * NORIA LLM Layer — model abstraction so the provider can be swapped.
 *
 * Priority chain (all free or cheapest-available):
 *   1. Groq  (llama-3.3-70b-versatile) — free tier, fast
 *   2. Gemini (gemini-2.0-flash)        — free tier
 *   3. Ollama (llama3)                  — local, 100% free
 *
 * At least one must be configured for NORIA to answer.
 */

async function groqComplete(messages, opts = {}) {
  const key = process.env.GROQ_API_KEY
  if (!key) throw new Error('GROQ_API_KEY not set')

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      messages,
      max_tokens: opts.maxTokens ?? 1200,
      temperature: opts.temperature ?? 0.4,
      stream: false,
    }),
  })
  if (!res.ok) throw new Error(`Groq error ${res.status}: ${await res.text()}`)
  const data = await res.json()
  return data.choices?.[0]?.message?.content ?? ''
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
  const providers = []
  if (process.env.GROQ_API_KEY) providers.push(() => groqComplete(messages, opts))
  if (process.env.GEMINI_API_KEY) providers.push(() => geminiComplete(messages, opts))
  if (process.env.OLLAMA_BASE_URL || process.env.OLLAMA_MODEL) providers.push(() => ollamaComplete(messages, opts))

  if (providers.length === 0)
    throw new Error('No LLM provider configured. Set GROQ_API_KEY, GEMINI_API_KEY, or OLLAMA_BASE_URL.')

  let lastErr = null
  for (const provider of providers) {
    try {
      const text = await provider()
      if (text?.trim()) return text.trim()
      console.warn('LLM provider returned empty response, trying next...')
    } catch (e) {
      console.warn('LLM provider failed:', e.message)
      lastErr = e
    }
  }
  throw lastErr ?? new Error('All LLM providers failed.')
}

export function activeProvider() {
  if (process.env.GROQ_API_KEY) return 'groq'
  if (process.env.GEMINI_API_KEY) return 'gemini'
  if (process.env.OLLAMA_BASE_URL || process.env.OLLAMA_MODEL) return 'ollama'
  return 'none'
}
