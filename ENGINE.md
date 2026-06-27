# NORIA Engine — Architecture & Operations

The backend that powers NORIA. One brain, served over HTTP, used by the
frontend (`index.html`). Built to be **free, resilient, current, and accurate.**

---

## 1. Files & responsibilities

| File | Role |
|---|---|
| `server.js` | HTTP API (Express): routing, rate-limiting, crash guards, diagnostics |
| `engine.js` | The pipeline: cache → guardrails → RAG → live search → LLM → response |
| `llm.js` | LLM providers + multi-key rotation, failover, cooldown, streaming |
| `searcher.js` | Live data: time, currency, crypto, weather, Wikipedia, web search |
| `cache.js` | In-memory answer cache (free capacity + speed multiplier) |
| `embedder.js` | Text → vector (for RAG) — *deployment-managed* |
| `vectorstore.js` | pgvector similarity search + schema — *deployment-managed* |
| `ingest.js` | Add knowledge to the vector store — *deployment-managed* |

---

## 2. Request flow (what happens on every question)

```
User → frontend → POST /v1/ask  or  /v1/ask/stream
  1. Guardrails        (block prompt-injection)
  2. Cache check       (generic repeat question → instant, free)
  3. RAG retrieval     (pgvector background knowledge, if DB set)
  4. Live web search   (only if the question needs current info)
  5. LLM completion    (Groq → Cerebras → Gemini, with failover)
  6. Cache store       (generic answers saved for next time)
  → answer (streamed token-by-token, or full JSON)
```

---

## 3. Providers & failover (all free)

**LLM order:** every Groq key → every Cerebras key → every OpenRouter key →
Gemini → Ollama. A key that hits a daily limit or has no model access is
**parked on cooldown** and skipped; the next key/provider takes over. Models:
- Groq: `llama-3.3-70b-versatile` → `llama-3.1-8b-instant`
- Cerebras: `gpt-oss-120b` → `zai-glm-4.7`
- Gemini: `gemini-2.0-flash-lite` (on by default when a key exists)

**Search order (free longevity):** Tavily → Google CSE → DuckDuckGo (keyless,
unlimited) → Serper (one-time credit, kept as reserve).

---

## 4. Environment variables (set in Render)

**LLM (comma-separated for multiple keys):**
`GROQ_API_KEYS`, `CEREBRAS_API_KEYS`, `OPENROUTER_API_KEYS`, `GEMINI_API_KEY`

**Search (any you have; all optional — DuckDuckGo works with none):**
`SEARCH_API_KEY` or `TAVILY_API_KEY` · `SERPER_API_KEY` ·
`GOOGLE_SEARCH_KEY` + `GOOGLE_SEARCH_CX`

**Other:** `DATABASE_URL` (RAG), `NORIA_SETUP_SECRET` (protects admin routes),
`RATE_LIMIT_PER_MIN` (default 200), `CACHE_TTL_MS` (6h), `CACHE_MAX` (2000),
`GEMINI_ENABLED=false` to disable Gemini.

---

## 5. Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness + which keys are present |
| `POST /v1/ask` | Main query (full JSON answer) |
| `POST /v1/ask/stream` | Streaming answer (SSE) |
| `POST /v1/feedback` | 👍/👎 from users |
| `POST /v1/ingest` | Add knowledge (admin) |
| `GET/POST /v1/setup` | Create schema + seed (admin) |

**Diagnostics (open in a browser; add `?secret=YOUR_NORIA_SETUP_SECRET`):**
- `/v1/test-llm` — are the LLM providers answering?
- `/v1/test-search` — which search providers are active + a live sample
- `/v1/test-cerebras` — which models each Cerebras key can use
- `/v1/cache-stats` — cache size + hit rate
- `/v1/feedback?rating=down` — answers users flagged (review & fix)

---

## 6. Resilience (why it won't go down)

- **Process crash guards** — unhandled errors are logged, not fatal.
- **Per-route try/catch** + global error middleware + JSON 404.
- **Every external call is time-boxed** and fails soft (search ≤5s deadline).
- **Streaming** stops cleanly on client disconnect.
- **Keep-warm** — point an uptime monitor at `/health` every ~10 min so the
  free Render tier never cold-starts.

---

## 7. Limits (free tier — honest)

Free quotas are **shared across all users** and reset daily/monthly (Serper is
one-time). Realistic capacity: **a few thousand active users/day**, degrading
gracefully (never crashing) when limits are hit. Caching multiplies this for
repeated questions. True large-scale (≫ that) requires paid LLM/search tiers.
