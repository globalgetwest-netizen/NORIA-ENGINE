/**
 * Drop-in replacement for the SkyGlobe website's NORIA API route.
 *
 * Copy this to:  web/src/app/api/noria/route.ts
 * Then DELETE the old in-app engine folder:  web/src/noria/
 * (NORIA now lives in its own service — the website only proxies to it.)
 *
 * Add to the SkyGlobe environment:
 *   NORIA_API_URL=https://noria-engine.onrender.com
 */

import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 30

const NORIA_API_URL = process.env.NORIA_API_URL || 'http://localhost:4000'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const query = String(body?.query ?? body?.message ?? '').trim()
    if (!query) return NextResponse.json({ error: 'query is required' }, { status: 400 })

    const upstream = await fetch(`${NORIA_API_URL}/v1/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, history: body?.history }),
    })

    const data = await upstream.json()
    return NextResponse.json(data)
  } catch (e) {
    console.error('NORIA proxy error:', e)
    return NextResponse.json(
      { answer: 'NORIA is temporarily unavailable. Please try again shortly.' },
      { status: 200 }
    )
  }
}
