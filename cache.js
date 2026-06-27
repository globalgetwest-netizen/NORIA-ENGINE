/**
 * NORIA answer cache — free, in-memory, zero dependencies.
 *
 * Common questions ("what is a CV?", "how do I start a business?") are answered
 * by the LLM once, then served instantly from memory to everyone else — no
 * tokens spent, no wait. This multiplies free capacity and speed for repeated
 * questions. It is deliberately conservative about WHAT it caches (see
 * engine.js isCacheable) so personalised or time-sensitive answers are never
 * served stale.
 *
 * Tunable via env: CACHE_TTL_MS (default 6h), CACHE_MAX (default 2000 entries).
 * The cache is per-process and resets on redeploy — that's fine; it simply
 * warms up again from real traffic.
 */

const TTL_MS = Number(process.env.CACHE_TTL_MS) || 6 * 60 * 60 * 1000
const MAX_ENTRIES = Number(process.env.CACHE_MAX) || 2000

const store = new Map() // normalisedQuery -> { answer, provider, exp }
let hits = 0
let misses = 0

function norm(q) {
  return String(q || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s¿¡"']+|[\s?.!,;:"']+$/g, '') // ignore surrounding punctuation/quotes
}

export function cacheGet(query) {
  const key = norm(query)
  if (!key) return null
  const entry = store.get(key)
  if (!entry) { misses++; return null }
  if (Date.now() > entry.exp) { store.delete(key); misses++; return null }
  // LRU touch: move to most-recent position.
  store.delete(key)
  store.set(key, entry)
  hits++
  return entry
}

export function cacheSet(query, answer, provider) {
  const key = norm(query)
  if (!key || !answer) return
  // Evict the oldest entry when full (Map preserves insertion order).
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value
    if (oldest !== undefined) store.delete(oldest)
  }
  store.set(key, { answer, provider: provider || 'cache', exp: Date.now() + TTL_MS })
}

export function cacheStats() {
  const total = hits + misses
  return {
    size: store.size,
    max: MAX_ENTRIES,
    ttlMs: TTL_MS,
    hits,
    misses,
    hitRate: total ? +(hits / total).toFixed(3) : 0,
  }
}
