/**
 * NORIA Web Search Grounding — live internet lookup for real-time data.
 *   1. Brave Search API (free 2,000/month)
 *   2. DuckDuckGo Instant Answers (free, no key)
 */

const NEEDS_LIVE_RE =
  /conference|event|news|current|latest|today|2024|2025|2026|deadline|price|rate|opening|scholarship|application|embassy|appointment/i

export function needsLiveSearch(query) {
  return NEEDS_LIVE_RE.test(query)
}

async function braveSearch(query) {
  const key = process.env.BRAVE_SEARCH_API_KEY
  if (!key) throw new Error('BRAVE_SEARCH_API_KEY not set')
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': key },
  })
  if (!res.ok) throw new Error(`Brave search error ${res.status}`)
  const data = await res.json()
  return (data.web?.results ?? []).slice(0, 5).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.description ?? '',
  }))
}

async function duckduckgoSearch(query) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
  const res = await fetch(url, { headers: { 'User-Agent': 'NORIA/1.0 (SkyGlobe AI assistant)' } })
  if (!res.ok) return []
  const data = await res.json()
  const results = []
  if (data.AbstractText)
    results.push({ title: data.Heading ?? query, url: data.AbstractURL ?? '', snippet: data.AbstractText })
  for (const r of (data.RelatedTopics ?? []).slice(0, 4)) {
    if (r.Text) results.push({ title: r.Text.slice(0, 60), url: r.FirstURL ?? '', snippet: r.Text })
  }
  return results
}

export async function webSearch(query) {
  if (process.env.BRAVE_SEARCH_API_KEY) {
    try {
      return await braveSearch(query)
    } catch (_) {}
  }
  return duckduckgoSearch(query)
}

export function formatSearchContext(results) {
  if (!results.length) return ''
  return (
    '\n\n[Live web sources retrieved ' +
    new Date().toISOString().slice(0, 10) +
    ']:\n' +
    results.map((r, i) => `[${i + 1}] ${r.title}\n    ${r.snippet}\n    Source: ${r.url}`).join('\n\n')
  )
}
