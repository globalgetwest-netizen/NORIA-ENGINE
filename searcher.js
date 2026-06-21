/**
 * NORIA Web Search Grounding — 5-layer search stack, never empty.
 *   1. Tavily AI Search     (1,000 free/month — best for AI)
 *   2. Serper.dev           (2,500 free searches)
 *   3. Google Custom Search (100 free/day = 3,000/month)
 *   4. You.com Search API   (1,000 free/month)
 *   5. DuckDuckGo           (unlimited free fallback, no key needed)
 */

const NEEDS_LIVE_RE =
  /conference|event|news|current|latest|today|2024|2025|2026|deadline|price|rate|opening|scholarship|application|embassy|appointment|election|coup|war|attack|crisis|conflict|protest|flood|earthquake|hurricane|pandemic|vaccine|sanction|policy|law|bill|summit|treaty|agreement|stock|market|currency|inflation|gdp|budget|president|prime minister|government|minister|arrest|killed|died|death|born|won|lost|signed|launched|announced|released|discovered/i

export function needsLiveSearch(query) {
  return NEEDS_LIVE_RE.test(query)
}

async function tavilySearch(query) {
  const key = process.env.TAVILY_API_KEY
  if (!key) throw new Error('TAVILY_API_KEY not set')
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key, query, search_depth: 'basic', max_results: 5 }),
  })
  if (!res.ok) throw new Error(`Tavily error ${res.status}`)
  const data = await res.json()
  return (data.results ?? []).slice(0, 5).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? '' }))
}

async function serperSearch(query) {
  const key = process.env.SERPER_API_KEY
  if (!key) throw new Error('SERPER_API_KEY not set')
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
    body: JSON.stringify({ q: query, num: 5 }),
  })
  if (!res.ok) throw new Error(`Serper error ${res.status}`)
  const data = await res.json()
  return (data.organic ?? []).slice(0, 5).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet ?? '' }))
}

async function googleSearch(query) {
  const key = process.env.GOOGLE_SEARCH_KEY
  const cx = process.env.GOOGLE_SEARCH_CX
  if (!key || !cx) throw new Error('GOOGLE_SEARCH_KEY or GOOGLE_SEARCH_CX not set')
  const url = `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&q=${encodeURIComponent(query)}&num=5`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Google search error ${res.status}`)
  const data = await res.json()
  return (data.items ?? []).slice(0, 5).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet ?? '' }))
}

async function youSearch(query) {
  const key = process.env.YOU_API_KEY
  if (!key) throw new Error('YOU_API_KEY not set')
  const url = `https://api.you.com/search?query=${encodeURIComponent(query)}&num_web_results=5`
  const res = await fetch(url, {
    headers: { 'X-API-Key': key },
  })
  if (!res.ok) throw new Error(`You.com search error ${res.status}`)
  const data = await res.json()
  return (data.hits ?? data.web_results ?? []).slice(0, 5).map((r) => ({
    title: r.title ?? r.name ?? '',
    url: r.url ?? r.link ?? '',
    snippet: r.description ?? r.snippet ?? '',
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
  if (process.env.TAVILY_API_KEY) {
    try { const r = await tavilySearch(query); if (r.length) return r } catch (_) {}
  }
  if (process.env.SERPER_API_KEY) {
    try { const r = await serperSearch(query); if (r.length) return r } catch (_) {}
  }
  if (process.env.GOOGLE_SEARCH_KEY && process.env.GOOGLE_SEARCH_CX) {
    try { const r = await googleSearch(query); if (r.length) return r } catch (_) {}
  }
  if (process.env.YOU_API_KEY) {
    try { const r = await youSearch(query); if (r.length) return r } catch (_) {}
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
