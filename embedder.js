/**
 * NORIA Embedder — converts text to vectors for semantic search.
 *
 *   1. Ollama embeddings (local, 100% free) — nomic-embed-text (dim 768)
 *   2. OpenAI text-embedding-3-small (fractions of a cent, dim 1536)
 *
 * EMBEDDING_DIM env var must match the pgvector column dimension.
 */

export const EMBEDDING_DIM = parseInt(process.env.EMBEDDING_DIM ?? '768', 10)

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

export async function embed(text) {
  if (process.env.OLLAMA_BASE_URL || !process.env.OPENAI_API_KEY) {
    try {
      return await ollamaEmbed(text)
    } catch (_) {}
  }
  if (process.env.OPENAI_API_KEY) return await openaiEmbed(text)
  throw new Error('No embedder configured. Set OLLAMA_BASE_URL or OPENAI_API_KEY.')
}

/** Split a long document into overlapping chunks for embedding */
export function chunkText(text, size = 400, overlap = 80) {
  const words = text.split(/\s+/)
  const chunks = []
  for (let i = 0; i < words.length; i += size - overlap) {
    chunks.push(words.slice(i, i + size).join(' '))
    if (i + size >= words.length) break
  }
  return chunks
}
