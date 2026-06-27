/**
 * NORIA Live Search — free, no-API-key web & real-time grounding.
 *
 * Every source here is FREE, requires NO API key, and is usable worldwide,
 * so it serves an unlimited number of users at $0:
 *   - Wikipedia (REST search + summary)  — encyclopedic & reasonably current facts
 *   - DuckDuckGo Instant Answer          — quick definitions / direct answers
 *   - Frankfurter (European Central Bank)— live currency exchange rates
 *   - CoinGecko                          — live cryptocurrency prices
 *   - Open-Meteo (+ its free geocoder)   — live weather, no key
 *
 * The engine calls:
 *   needsLiveSearch(query)    -> boolean   (should we fetch live data?)
 *   webSearch(query)          -> [{title, snippet, url, kind}]
 *   formatSearchContext(rows) -> string    (block injected into the prompt)
 *
 * All network calls are time-boxed and fail soft: if a source is slow or down,
 * it is skipped and Noria simply answers from her own knowledge.
 */

const FETCH_TIMEOUT_MS = 3500   // per request — keep the UI responsive
const SEARCH_DEADLINE_MS = 5000 // hard cap on the WHOLE search so Noria never hangs
const UA = 'NoriaBot/1.0 (+https://skyglobegroup.com)'

// Resolve to `fallback` if `promise` doesn't settle within ms — guarantees the
// search can never block the answer for longer than the deadline.
function withDeadline(promise, ms, fallback) {
  return Promise.race([promise, new Promise((res) => setTimeout(() => res(fallback), ms))])
}

async function fetchJSON(url, opts = {}) {
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), opts.timeout || FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) },
    })
    if (!res.ok) return null
    return await res.json()
  } catch (_) {
    return null
  } finally {
    clearTimeout(to)
  }
}

// ── When do we need live data? ───────────────────────────────────────────────
// Trigger on recency words, money/markets, weather, news, sports, current
// office-holders, and explicit recent years. Deliberately conservative so we
// don't add latency to ordinary questions.
const LIVE_PATTERNS = [
  /\b(latest|current|currently|recent|recently|today|tonight|now|this (week|month|year)|up[\s-]?to[\s-]?date|breaking|as of)\b/i,
  /\b(news|headlines?|happening|developments?)\b/i,
  /\b(price|prices|cost|costs|rate|rates|exchange rate|stock|shares?|market|markets|inflation|gdp)\b/i,
  /\b(weather|temperature|forecast|how (hot|cold|warm))\b/i,
  /\bwho('?s| is| are)? (the )?(current|present|new)?\s*(president|prime minister|pm|ceo|leader|king|queen|pope|chancellor|governor|mayor)\b/i,
  /\b(score|scores|results?|final score|who won|winner|standings|fixtures?)\b/i,
  /\bhow much (is|are|does|do)\b/i,
  /\b20(2[4-9]|[3-9]\d)\b/, // 2024 and later
  // Factual lookups that benefit from grounding (improves accuracy):
  /\bhow many\b/i,
  /\b(population|capital|gdp|area|distance|height|length|net worth|salary|founded|established|launched|released)\b/i,
  /\b(when (is|was|did|will)|what year|what date|release date|deadline)\b/i,
  /\b(ceo|founder|owner|director|minister|senator|governor) of\b/i,
  /\b(statistics|stats|figures|data|ranking|rankings|record)\b/i,
  // bare currency pair, e.g. "USD to EUR", "GBP/NGN", "EUR = USD"
  /\b(USD|EUR|GBP|JPY|CNY|CHF|CAD|AUD|NZD|INR|NGN|GHS|ZAR|KES|EGP|AED|SAR|BRL|RUB|TRY|SEK|NOK|DKK|PLN|MXN|SGD|HKD|KRW)\b\s*(?:to|in|vs|=|\/)?\s*\b(USD|EUR|GBP|JPY|CNY|CHF|CAD|AUD|NZD|INR|NGN|GHS|ZAR|KES|EGP|AED|SAR|BRL|RUB|TRY|SEK|NOK|DKK|PLN|MXN|SGD|HKD|KRW)\b/i,
]

export function needsLiveSearch(query) {
  if (!query || typeof query !== 'string') return false
  const q = query.trim()
  if (q.length < 3) return false
  return LIVE_PATTERNS.some((p) => p.test(q))
}

// ── Currency exchange rates (Frankfurter / ECB) ──────────────────────────────
const CURRENCIES = '(USD|EUR|GBP|JPY|CNY|CHF|CAD|AUD|NZD|INR|NGN|GHS|ZAR|KES|EGP|AED|SAR|BRL|RUB|TRY|SEK|NOK|DKK|PLN|MXN|SGD|HKD|KRW)'
async function currencyLookup(query) {
  const m = query.toUpperCase().match(new RegExp(`${CURRENCIES}\\s*(?:TO|IN|=|\\/|VS)\\s*${CURRENCIES}`))
  if (!m) return null
  const from = m[1], to = m[2]
  const data = await fetchJSON(`https://api.frankfurter.app/latest?from=${from}&to=${to}`)
  if (!data?.rates?.[to]) return null
  return {
    kind: 'currency',
    title: `Exchange rate ${from} → ${to}`,
    snippet: `1 ${from} = ${data.rates[to]} ${to} (as of ${data.date}, European Central Bank reference rate).`,
    url: 'https://www.ecb.europa.eu',
  }
}

// ── Crypto prices (CoinGecko) ────────────────────────────────────────────────
const COIN_IDS = {
  bitcoin: 'bitcoin', btc: 'bitcoin', ethereum: 'ethereum', eth: 'ethereum',
  bnb: 'binancecoin', solana: 'solana', sol: 'solana', xrp: 'ripple', ripple: 'ripple',
  cardano: 'cardano', ada: 'cardano', dogecoin: 'dogecoin', doge: 'dogecoin',
  litecoin: 'litecoin', ltc: 'litecoin', usdt: 'tether', tether: 'tether',
}
async function cryptoLookup(query) {
  const q = query.toLowerCase()
  const hit = Object.keys(COIN_IDS).find((k) => new RegExp(`\\b${k}\\b`).test(q))
  if (!hit) return null
  const id = COIN_IDS[hit]
  const data = await fetchJSON(
    `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true`
  )
  const row = data?.[id]
  if (!row?.usd) return null
  const chg = typeof row.usd_24h_change === 'number' ? ` (${row.usd_24h_change.toFixed(2)}% in 24h)` : ''
  return {
    kind: 'crypto',
    title: `${hit.toUpperCase()} price`,
    snippet: `${id} is currently $${row.usd.toLocaleString('en-US')} USD${chg}.`,
    url: 'https://www.coingecko.com',
  }
}

// ── Weather (Open-Meteo, with its free geocoder) ─────────────────────────────
async function weatherLookup(query) {
  if (!/\b(weather|temperature|forecast|how (hot|cold|warm))\b/i.test(query)) return null
  // crude place extraction: "weather in X" / "X weather"
  let place = null
  const m1 = query.match(/\b(?:weather|temperature|forecast)\s+(?:in|at|for)\s+([A-Za-zÀ-ɏ .'-]{2,40})/i)
  const m2 = query.match(/\bin\s+([A-Za-zÀ-ɏ .'-]{2,40})\b/i)
  place = (m1 && m1[1]) || (m2 && m2[1]) || null
  if (!place) return null
  place = place.replace(/[?.!,]+$/, '').trim()
  const geo = await fetchJSON(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1`
  )
  const loc = geo?.results?.[0]
  if (!loc) return null
  const wx = await fetchJSON(
    `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code`
  )
  const c = wx?.current
  if (!c) return null
  return {
    kind: 'weather',
    title: `Weather in ${loc.name}${loc.country ? ', ' + loc.country : ''}`,
    snippet: `Currently ${c.temperature_2m}°C, humidity ${c.relative_humidity_2m}%, wind ${c.wind_speed_10m} km/h (live).`,
    url: 'https://open-meteo.com',
  }
}

// ── Wikipedia (search → summaries) ───────────────────────────────────────────
async function wikipediaLookup(query) {
  const search = await fetchJSON(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=2&format=json&origin=*&srsearch=${encodeURIComponent(query)}`
  )
  const hits = search?.query?.search || []
  if (!hits.length) return []
  // Fetch the top summaries IN PARALLEL (was sequential → caused long hangs).
  const sums = await Promise.all(
    hits.slice(0, 2).map((h) =>
      fetchJSON(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(h.title.replace(/ /g, '_'))}`)
        .then((sum) =>
          sum?.extract
            ? {
                kind: 'wikipedia',
                title: sum.title || h.title,
                snippet: sum.extract,
                url: sum.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(h.title)}`,
              }
            : null
        )
        .catch(() => null)
    )
  )
  return sums.filter(Boolean).slice(0, 1) // keep only the best to avoid noise
}

// ── DuckDuckGo Instant Answer ────────────────────────────────────────────────
async function duckduckgoLookup(query) {
  const data = await fetchJSON(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
  )
  if (!data) return []
  const rows = []
  if (data.AbstractText) {
    rows.push({ kind: 'web', title: data.Heading || query, snippet: data.AbstractText, url: data.AbstractURL || '' })
  } else if (data.Answer) {
    rows.push({ kind: 'web', title: data.AnswerType || query, snippet: String(data.Answer), url: '' })
  }
  return rows
}

// ── Orchestrator ─────────────────────────────────────────────────────────────
export async function webSearch(query) {
  if (!query) return []
  // Run structured lookups (fast, exact) and general lookups in parallel, but
  // never let the whole thing exceed the deadline — if it does, we return what
  // we can and Noria answers from her own knowledge (no hanging on the user).
  const settled = await withDeadline(
    Promise.allSettled([
      currencyLookup(query),
      cryptoLookup(query),
      weatherLookup(query),
      wikipediaLookup(query),
      duckduckgoLookup(query),
    ]),
    SEARCH_DEADLINE_MS,
    []
  )

  const results = []
  for (const s of settled) {
    if (s.status !== 'fulfilled' || !s.value) continue
    if (Array.isArray(s.value)) results.push(...s.value)
    else results.push(s.value)
  }

  // De-duplicate by title, keep structured (currency/crypto/weather) first.
  const order = { currency: 0, crypto: 0, weather: 0, web: 1, wikipedia: 2 }
  results.sort((a, b) => (order[a.kind] ?? 3) - (order[b.kind] ?? 3))
  const seen = new Set()
  const unique = []
  for (const r of results) {
    const key = (r.title || '').toLowerCase().trim()
    if (key && seen.has(key)) continue
    seen.add(key)
    unique.push(r)
  }
  return unique.slice(0, 5)
}

// ── Format into a prompt context block ───────────────────────────────────────
export function formatSearchContext(results) {
  if (!results || !results.length) return ''
  const today = new Date().toISOString().slice(0, 10)
  const lines = results.map((r) => `• ${r.title}: ${r.snippet}`).join('\n')
  return (
    '\n\n[LIVE REFERENCE retrieved just now (' + today + '). Use ONLY the items directly relevant to the question, ' +
    'to make any current facts/figures accurate. IGNORE anything not relevant. For reasoning, analysis, and depth, ' +
    'rely on your own expert knowledge — do not let these snippets narrow your answer. Never cite, footnote, or list ' +
    'them as sources]:\n' +
    lines
  )
}
