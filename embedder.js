/**
 * NORIA Embedder — converts text to vectors for semantic search.
 *
 *   1. Gemini text-embedding-004 (FREE, 768 dimensions)
 *   2. OpenAI text-embedding-3-small (paid, 1536 dimensions)
 *   3. Ollama nomic-embed-text (local, free, 768 dimensions)
 *
 * EMBEDDING_DIM env var must match the pgvector column dimension.
 */

export const EMBEDDING_DIM = parseInt(process.env.EMBEDDING_DIM ?? '768', 10)

async function geminiEmbed(text) {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY not set')
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'models/text-embedding-004',
        content: { parts: [{ text }] },
      }),
    }
  )
  if (!res.ok) throw new Error(`Gemini embed error ${res.status}: ${await res.text()}`)
  const data = await res.json()
  return data.embedding?.values
}

async function openaiEmbed(text) {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('OPENAI_API_KEY not set')
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
  })
  if (!res.ok) throw new Error(`OpenAI embed error ${res.status}`)
  const data = await res.json()
  return data.data?.[0]?.embedding
}

async function ollamaEmbed(text) {
  const base = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434'
  const model = process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text'
  const res = await fetch(`${base}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: text }),
  })
  if (!res.ok) throw new Error(`Ollama embed error ${res.status}`)
  const data = await res.json()
  return data.embedding
}

export async function embed(text) {
  if (process.env.GEMINI_API_KEY) {
    try { return await geminiEmbed(text) } catch (e) { console.warn('Gemini embed failed:', e.message) }
  }
  if (process.env.OPENAI_API_KEY) {
    try { return await openaiEmbed(text) } catch (e) { console.warn('OpenAI embed failed:', e.message) }
  }
  if (process.env.OLLAMA_BASE_URL) {
    try { return await ollamaEmbed(text) } catch (e) { console.warn('Ollama embed failed:', e.message) }
  }
  throw new Error('No embedder configured. Set GEMINI_API_KEY, OPENAI_API_KEY, or OLLAMA_BASE_URL.')
}

export function chunkText(text, size = 400, overlap = 80) {
  const words = text.split(/\s+/)
  const chunks = []
  for (let i = 0; i < words.length; i += size - overlap) {
    chunks.push(words.slice(i, i + size).join(' '))
    if (i + size >= words.length) break
  }
  return chunks
}
