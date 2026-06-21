/**
 * One-time setup script: create pgvector schema + seed baseline knowledge.
 * Run with:  npm run setup
 */

import 'dotenv/config'
import { setupSchema } from './vectorstore.js'
import { seedKnowledge } from './ingest.js'

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set. Add it to your .env first.')
    process.exit(1)
  }
  console.log('Creating pgvector schema...')
  await setupSchema()
  console.log('Schema ready.')
  await seedKnowledge()
  console.log('Done. NORIA is ready to answer.')
  process.exit(0)
}

main().catch((e) => {
  console.error('Setup failed:', e.message)
  process.exit(1)
})
