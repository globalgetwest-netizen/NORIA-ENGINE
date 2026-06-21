# NORIA Engine

**NORIA** — SkyGlobe's standalone AI intelligence engine. One brain, many products.

NORIA is intentionally separate from the SkyGlobe website. The website (and any
future SkyGlobe product — health, finance, education, maps, etc.) talks to NORIA
over a single HTTP API. This keeps the brain reusable and the apps simple.

```
┌────────────────┐     POST /v1/ask      ┌──────────────────────────┐
│ SkyGlobe site  │ ────────────────────► │       NORIA Engine        │
│ (Next.js)      │                       │  guardrails → RAG → web   │
│                │ ◄──────────────────── │  search → LLM → citations │
└────────────────┘    { answer, ... }    └──────────────────────────┘
   future apps ──────────────────────────────────┘  │
   (health, finance...)                              ▼
                                          PostgreSQL + pgvector (memory)
```

## Architecture (3-layer RAG)

1. **Foundation** — LLM provider chain: Groq (free) → Gemini (free) → Ollama (local). `src/llm.js`
2. **Custom knowledge** — PostgreSQL + pgvector semantic search. `src/vectorstore.js`, `src/embedder.js`
3. **Live grounding** — Brave Search (free tier) → DuckDuckGo (free). `src/searcher.js`

Orchestrated in `src/engine.js`: guardrails → retrieve → web search → LLM → citations → logging.

## Cost: $0 to run

| Layer | Free option |
|---|---|
| LLM | Groq free tier OR Gemini free tier OR Ollama (local) |
| Embeddings | Ollama `nomic-embed-text` (local) |
| Vector DB | Your own PostgreSQL + pgvector |
| Web search | DuckDuckGo (no key) |

## Quick start

```bash
npm install
cp .env.example .env      # fill in GROQ_API_KEY and DATABASE_URL
npm run setup             # creates pgvector schema + seeds SkyGlobe knowledge
npm run dev               # starts on http://localhost:4000
```

Test it:

```bash
curl -X POST http://localhost:4000/v1/ask \
  -H "Content-Type: application/json" \
  -d '{"query":"How do I apply for a UK student visa?"}'
```

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | — | Liveness + which provider/DB is active |
| POST | `/v1/ask` | — | `{ query, history? }` → `{ answer, sources, ... }` |
| POST | `/v1/ingest` | Bearer | `{ source, content }` → add knowledge |
| POST | `/v1/setup` | Bearer | create schema + seed (run once) |

Admin endpoints require header `Authorization: Bearer <NORIA_SETUP_SECRET>`.

## Connecting the SkyGlobe website

Set `NORIA_API_URL` on the SkyGlobe site, then have its `/api/noria` route
proxy to `${NORIA_API_URL}/v1/ask`. A drop-in connector is provided in
`integration/skyglobe-route.ts`.

## Deploy

Push to GitHub, then deploy on Render (free plan) — `render.yaml` is included.
After first deploy, call `/v1/setup` once with your secret to initialise the DB.
