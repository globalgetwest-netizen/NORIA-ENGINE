/**
 * NORIA shared PostgreSQL pool.
 *
 * One pool for the whole process — reused by the vector store, auth, and billing
 * so we never open duplicate connection pools to the same Neon/Render database.
 * Uses DATABASE_URL. SSL is enabled automatically for hosted providers.
 */

import pg from 'pg'

const { Pool } = pg
let _pool = null

export function getPool() {
  if (_pool) return _pool
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not configured')
  _pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: /render\.com|amazonaws\.com|supabase|neon\.tech/.test(process.env.DATABASE_URL || '')
      ? { rejectUnauthorized: false }
      : false,
    max: Number(process.env.PG_POOL_MAX) || 5,
    idleTimeoutMillis: 30_000,
  })
  _pool.on('error', (err) => console.error('PG pool error (kept alive):', err.message))
  return _pool
}

export const hasDb = () => !!process.env.DATABASE_URL
