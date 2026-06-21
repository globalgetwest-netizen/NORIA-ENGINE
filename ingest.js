/**
 * NORIA Vector Store — PostgreSQL + pgvector.
 * Uses DATABASE_URL. No extra vendor, no subscription.
 */

import pg from 'pg'
import { EMBEDDING_DIM } from './embedder.js'

const { Pool } = pg
let _pool = null

function getPool() {
  if (_pool) return _pool
  _pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: /render\.com|amazonaws\.com|supabase/.test(process.env.DATABASE_URL || '')
      ? { rejectUnauthorized: false }
      : false,
  })
  return _pool
}

export async function setupSchema() {
  const pool = getPool()
  await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS noria_documents (
      id         BIGSERIAL PRIMARY KEY,
      source     TEXT NOT NULL,
      content    TEXT NOT NULL,
      embedding  vector(${EMBEDDING_DIM}),
      metadata   JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS noria_docs_embedding_idx
      ON noria_documents USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100)
  `)
}

export async function upsertDocument(source, content, embedding, metadata = {}) {
  const pool = getPool()
  const vec = `[${embedding.join(',')}]`
  await pool.query(
    `INSERT INTO noria_documents (source, content, embedding, metadata)
     VALUES ($1, $2, $3::vector, $4)`,
    [source, content, vec, JSON.stringify(metadata)]
  )
}

export async function similaritySearch(embedding, topK = 5) {
  const pool = getPool()
  const vec = `[${embedding.join(',')}]`
  const { rows } = await pool.query(
    `SELECT id, source, content, metadata,
            1 - (embedding <=> $1::vector) AS similarity
     FROM noria_documents
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [vec, topK]
  )
  return rows
}
