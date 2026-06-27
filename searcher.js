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
  /\b(current|latest|today'?s?)\s+(price|news|events?|affairs|rate|score|situation|status|version)\b/i,
  /\b(what'?s happening|trending|breaking news|live)\b/i,
  /\b(current\s+time|what\s+time|time\s+(?:right\s+)?now|time\s+in|current\s+date|today'?s?\s+date|what\s+day\s+is)\b/i,
  // bare currency pair, e.g. "USD to EUR", "GBP/NGN", "EUR = USD"
  /\b(USD|EUR|GBP|JPY|CNY|CHF|CAD|AUD|NZD|INR|NGN|GHS|ZAR|KES|EGP|AED|SAR|BRL|RUB|TRY|SEK|NOK|DKK|PLN|MXN|SGD|HKD|KRW)\b\s*(?:to|in|vs|=|\/)?\s*\b(USD|EUR|GBP|JPY|CNY|CHF|CAD|AUD|NZD|INR|NGN|GHS|ZAR|KES|EGP|AED|SAR|BRL|RUB|TRY|SEK|NOK|DKK|PLN|MXN|SGD|HKD|KRW)\b/i,
  // Broad real-world / world-knowledge questions (people, places, orgs, events,
  // quantities) — these benefit from live grounding so Noria stays current and
  // accurate globally, not just on prices.
  /\bwho\s+(is|are|was|were|won|leads?|owns?|founded|created|invented|wrote|plays?|runs?|heads?)\b/i,
  /\bwhen\s+(is|are|was|were|did|does|will|do)\b/i,
  /\bwhere\s+(is|are|was|were|can|do|does)\b/i,
  /\bwhich\s+(country|company|team|player|city|year|leader|president)\b/i,
  /\b(president|prime minister|leader|king|queen|emir|sultan|chancellor|governor|senator|minister|ambassador|ceo|founder|owner|champion|winner|holder)\s+of\b/i,
  /\b(election|elected|won|winner|champion|trophy|cup|final|match|tournament|olympics|world cup)\b/i,
  /\b(how (old|tall|big|long|far|fast|rich|wealthy)|net worth|salary|revenue|valuation|market cap)\b/i,
  /\b(news|update|situation|conflict|war|crisis|disaster|outbreak|policy|sanction|deal|agreement|summit) (in|on|about|for|of)\b/i,
]

// Clearly TIMELESS / non-searchable requests — answer from the model directly,
// no web call (saves quota + latency): creative writing, documents, code,
// translation/editing, definitions of stable concepts, personal advice.
const SKIP_LIVE = [
  /\b(poem|poetry|story|song|lyrics|joke|riddle|essay|screenplay|fiction|brainstorm|imagine)\b/i,
  /\b(write|draft|compose|create|generate|design|build|make)\s+(me\s+)?(a|an|my|the)?\s*(cv|résumé|resume|cover letter|letter|business plan|proposal|report|contract|agreement|document|memo|email|speech|bio|profile)\b/i,
  /\b(translate|summari[sz]e|rephrase|reword|rewrite|proofread|edit|correct|fix)\b/i,
  /\b(code|function|program|script|algorithm|regex|sql|html|css|javascript|python)\b/i,
  /\b(how do i feel|should i|what should i|advice|motivat|inspire me|cheer me)\b/i,
]

export function needsLiveSearch(query) {
  if (!query || typeof query !== 'string') return false
  const q = query.trim()
  if (q.length < 4) return false
  if (SKIP_LIVE.some((p) => p.test(q))) return false // timeless/creative → no search
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

// ── Current time / date (authoritative — from the server clock, never the web)
// Web snippets for "current time" are stale (indexed days ago). The real clock
// is the server's own Date + the correct timezone, computed instantly & free.
const TZ_MAP = {
  ghana: 'Africa/Accra', nigeria: 'Africa/Lagos', kenya: 'Africa/Nairobi', tanzania: 'Africa/Dar_es_Salaam',
  uganda: 'Africa/Kampala', 'south africa': 'Africa/Johannesburg', egypt: 'Africa/Cairo', morocco: 'Africa/Casablanca',
  ethiopia: 'Africa/Addis_Ababa', senegal: 'Africa/Dakar', 'ivory coast': 'Africa/Abidjan', cameroon: 'Africa/Douala',
  uk: 'Europe/London', 'united kingdom': 'Europe/London', london: 'Europe/London', ireland: 'Europe/Dublin',
  france: 'Europe/Paris', germany: 'Europe/Berlin', spain: 'Europe/Madrid', italy: 'Europe/Rome',
  netherlands: 'Europe/Amsterdam', turkey: 'Europe/Istanbul', russia: 'Europe/Moscow',
  usa: 'America/New_York', 'united states': 'America/New_York', america: 'America/New_York', 'new york': 'America/New_York',
  'los angeles': 'America/Los_Angeles', california: 'America/Los_Angeles', chicago: 'America/Chicago',
  canada: 'America/Toronto', toronto: 'America/Toronto', brazil: 'America/Sao_Paulo', mexico: 'America/Mexico_City',
  india: 'Asia/Kolkata', pakistan: 'Asia/Karachi', bangladesh: 'Asia/Dhaka', china: 'Asia/Shanghai',
  japan: 'Asia/Tokyo', korea: 'Asia/Seoul', singapore: 'Asia/Singapore', malaysia: 'Asia/Kuala_Lumpur',
  indonesia: 'Asia/Jakarta', philippines: 'Asia/Manila', dubai: 'Asia/Dubai', uae: 'Asia/Dubai',
  'saudi arabia': 'Asia/Riyadh', qatar: 'Asia/Qatar', israel: 'Asia/Jerusalem',
  australia: 'Australia/Sydney', sydney: 'Australia/Sydney', 'new zealand': 'Pacific/Auckland',
  // Major cities (so "time in Tokyo" etc. resolve directly)
  tokyo: 'Asia/Tokyo', beijing: 'Asia/Shanghai', shanghai: 'Asia/Shanghai', 'hong kong': 'Asia/Hong_Kong',
  paris: 'Europe/Paris', berlin: 'Europe/Berlin', madrid: 'Europe/Madrid', rome: 'Europe/Rome',
  moscow: 'Europe/Moscow', istanbul: 'Europe/Istanbul', amsterdam: 'Europe/Amsterdam',
  lagos: 'Africa/Lagos', accra: 'Africa/Accra', nairobi: 'Africa/Nairobi', cairo: 'Africa/Cairo',
  johannesburg: 'Africa/Johannesburg', casablanca: 'Africa/Casablanca', 'addis ababa': 'Africa/Addis_Ababa',
  mumbai: 'Asia/Kolkata', delhi: 'Asia/Kolkata', karachi: 'Asia/Karachi', dhaka: 'Asia/Dhaka',
  jakarta: 'Asia/Jakarta', manila: 'Asia/Manila', seoul: 'Asia/Seoul', bangkok: 'Asia/Bangkok',
  riyadh: 'Asia/Riyadh', doha: 'Asia/Qatar', jerusalem: 'Asia/Jerusalem',
}
function timeLookup(query) {
  if (!/\b(current\s+time|what(?:'?s| is)?\s+the\s+time|what\s+time\s+is\s+it|time\s+(?:right\s+)?now|time\s+in\b|current\s+date|what(?:'?s| is)?\s+(?:the\s+)?date|today'?s?\s+date|what\s+day\s+is)\b/i.test(query)) {
    return null
  }
  const ql = query.toLowerCase()
  let tz = 'UTC', label = 'UTC (Greenwich Mean Time)'
  for (const [name, zone] of Object.entries(TZ_MAP)) {
    if (ql.includes(name)) { tz = zone; label = name.replace(/\b\w/g, (c) => c.toUpperCase()); break }
  }
  let when
  try {
    when = new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'full', timeStyle: 'long' }).format(new Date())
  } catch (_) {
    when = new Date().toUTCString(); tz = 'UTC'; label = 'UTC'
  }
  return {
    kind: 'time',
    title: `Current date & time — ${label}`,
    snippet: `Right now it is ${when} (timezone ${tz}). This is the exact, real-time current date and time.`,
    url: '',
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

// ── General web search (the ChatGPT-style live results) ──────────────────────
// Tries every provider you have a key for, in order: Tavily → Serper →
// Google CSE → keyless DuckDuckGo. Reads several common env-var names for each
// so your existing keys are picked up regardless of exact naming.
function envAny(...names) {
  for (const n of names) { const v = process.env[n]; if (v && String(v).trim()) return String(v).trim() }
  return ''
}
const TAVILY_KEY = () => envAny('SEARCH_API_KEY', 'TAVILY_API_KEY', 'TAVILY_KEY', 'TAVILY')
const SERPER_KEY = () => envAny('SERPER_API_KEY', 'SERPER_KEY', 'SERPER')
const GOOGLE_KEY = () => envAny('GOOGLE_SEARCH_KEY', 'GOOGLE_SEARCH_API_KEY', 'GOOGLE_CSE_KEY', 'GOOGLE_API_KEY')
const GOOGLE_CX = () => envAny('GOOGLE_SEARCH_CX', 'GOOGLE_CX', 'GOOGLE_CSE_CX', 'GOOGLE_CSE_ID', 'GOOGLE_SEARCH_CSE', 'CX')

// Which providers are configured (booleans only — never the key values).
export function searchProviders() {
  return {
    tavily: !!TAVILY_KEY(),
    serper: !!SERPER_KEY(),
    googleCse: !!(GOOGLE_KEY() && GOOGLE_CX()),
    duckduckgo: true, // always available (keyless)
  }
}

async function tavilySearch(query) {
  const key = TAVILY_KEY()
  if (!key) return null
  const data = await fetchJSON('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key, query, max_results: 4, search_depth: 'basic', include_answer: true }),
  })
  if (!data) return null
  const rows = []
  if (data.answer) rows.push({ kind: 'web', title: 'Live web answer', snippet: String(data.answer), url: '' })
  for (const r of (data.results || []).slice(0, 3)) {
    if (r?.content) rows.push({ kind: 'web', title: r.title || 'Web result', snippet: String(r.content).slice(0, 400), url: r.url || '' })
  }
  return rows.length ? rows : null
}

async function serperSearch(query) {
  const key = SERPER_KEY()
  if (!key) return null
  const data = await fetchJSON('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
    body: JSON.stringify({ q: query, num: 5 }),
  })
  if (!data) return null
  const rows = []
  const ab = data.answerBox
  if (ab) rows.push({ kind: 'web', title: ab.title || 'Answer', snippet: ab.answer || ab.snippet || '', url: ab.link || '' })
  if (data.knowledgeGraph?.description) rows.push({ kind: 'web', title: data.knowledgeGraph.title || 'Info', snippet: data.knowledgeGraph.description, url: '' })
  for (const r of (data.organic || []).slice(0, 3)) rows.push({ kind: 'web', title: r.title || 'Web result', snippet: r.snippet || '', url: r.link || '' })
  const out = rows.filter((r) => r.snippet)
  return out.length ? out : null
}

async function googleCseSearch(query) {
  const key = GOOGLE_KEY(), cx = GOOGLE_CX()
  if (!key || !cx) return null
  const data = await fetchJSON(
    `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}&num=4&q=${encodeURIComponent(query)}`
  )
  if (!data) return null
  const rows = []
  for (const it of (data.items || []).slice(0, 4)) {
    if (it?.snippet) rows.push({ kind: 'web', title: it.title || 'Web result', snippet: it.snippet, url: it.link || '' })
  }
  return rows.length ? rows : null
}

async function duckduckgoHtmlSearch(query) {
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' },
    })
    if (!res.ok) return null
    const html = await res.text()
    const rows = []
    const re = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
    let m
    while ((m = re.exec(html)) && rows.length < 3) {
      const text = m[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x2F;/g, '/')
        .replace(/\s+/g, ' ').trim()
      if (text) rows.push({ kind: 'web', title: 'Web result', snippet: text, url: '' })
    }
    return rows.length ? rows : null
  } catch (_) {
    return null
  } finally {
    clearTimeout(to)
  }
}

// Provider order favours free longevity: Tavily (monthly) → Google CSE (daily)
// → keyless DuckDuckGo (unlimited) → Serper LAST (one-time credit, preserved as
// a reserve so it isn't burned early). Each is skipped if it returns nothing.
async function generalWebSearch(query) {
  return (
    (await tavilySearch(query)) ||
    (await googleCseSearch(query)) ||
    (await duckduckgoHtmlSearch(query)) ||
    (await serperSearch(query)) ||
    []
  )
}

// ── Orchestrator ─────────────────────────────────────────────────────────────
export async function webSearch(query) {
  if (!query) return []
  // Time/date is answered authoritatively from the server clock — never the web
  // (web snippets are stale). Return it alone so nothing can contradict it.
  const timeRes = timeLookup(query)
  if (timeRes) return [timeRes]
  // Run structured lookups (fast, exact) and general lookups in parallel, but
  // never let the whole thing exceed the deadline — if it does, we return what
  // we can and Noria answers from her own knowledge (no hanging on the user).
  const settled = await withDeadline(
    Promise.allSettled([
      currencyLookup(query),
      cryptoLookup(query),
      weatherLookup(query),
      generalWebSearch(query),
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
    // De-dupe by snippet content (titles can repeat, e.g. "Web result").
    const key = (r.snippet || r.title || '').toLowerCase().replace(/\s+/g, ' ').slice(0, 80).trim()
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
