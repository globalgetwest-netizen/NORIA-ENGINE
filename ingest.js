/**
 * NORIA Ingest Pipeline — chunk → embed → store in pgvector.
 */

import { embed, chunkText } from './embedder.js'
import { upsertDocument, setupSchema } from './vectorstore.js'

let AFRICA_KNOWLEDGE = []
try {
  const mod = await import('./africa-knowledge.js')
  AFRICA_KNOWLEDGE = mod.AFRICA_KNOWLEDGE ?? []
} catch (_) {
  console.warn('NORIA: africa-knowledge.js not found — skipping Africa seed.')
}

export async function ingestText(source, text, metadata = {}) {
  await setupSchema()
  const chunks = chunkText(text)
  let count = 0
  for (const chunk of chunks) {
    const vec = await embed(chunk)
    await upsertDocument(source, chunk, vec, metadata)
    count++
  }
  return count
}

export async function ingestDocuments(docs) {
  await setupSchema()
  const results = []
  for (const doc of docs) {
    const chunks = await ingestText(doc.source, doc.content, doc.metadata ?? {})
    results.push({ source: doc.source, chunks })
  }
  return results
}

export const SKYGLOBE_SEED = [
  {
    source: 'skyglobe-overview',
    content: `SkyGlobe Group Limited is a global mobility and immigration consultancy headquartered in London, with offices in Lagos and Dubai. We help individuals and organisations navigate international movement — from study and work to residency and beyond. We have handled over 5,000 cases across 47 countries with a 98% success rate and 10+ years of experience. Our services include: Study Abroad (UK, USA, Canada, Australia, Germany), Work Permits, Visit Visas, EU Employment matching, Immigration Support, Conferences & Events, and Business Setup. Contact: info@skyglobegroup.com | +1 (800) SKYGLOBE`,
  },
  {
    source: 'skyglobe-services-study',
    content: `SkyGlobe Study Abroad service covers: UK Student Route visa, USA F-1 student visa, Canada Study Permit, Australia Subclass 500, Germany student visa. We handle university applications, scholarship searches (we have secured $2M+ in scholarships), financial proof preparation, and interview preparation. Typical processing: 4–12 weeks depending on destination. Requirements: valid passport, acceptance letter, financial evidence, language test scores (IELTS/TOEFL).`,
  },
  {
    source: 'skyglobe-services-work',
    content: `SkyGlobe Work Permit services: UK Skilled Worker visa, Canada Express Entry, Germany Job Seeker visa, EU Blue Card, UAE work permit. We assist with employer sponsorship, credential recognition, job matching through our EU Employment programme, and document legalisation. The EU Employment programme connects skilled African professionals with vetted employers across EU member states.`,
  },
  {
    source: 'skyglobe-services-visit',
    content: `SkyGlobe Visit Visa service covers tourism, family visits, and business travel visas for Schengen, UK, USA, Canada, UAE, and Australia. We prepare your application pack, cover letters, financial statements, and handle submission. Typical success rate: 95%+ with proper documentation.`,
  },
  {
    source: 'skyglobe-pricing',
    content: `SkyGlobe pricing plans: Starter ($299) — 1 visa application, NORIA AI guidance, document checklist, email support, case tracking. Professional ($699) — 3 visa applications, priority NORIA access, document review, priority support, EU Employment matching, monthly consultations. Enterprise (Custom) — unlimited applications, dedicated case manager, API access, SLA guarantee, staff portal. All prices exclude government visa fees.`,
  },
  {
    source: 'noria-identity',
    content: `NORIA is SkyGlobe's AI intelligence engine — Neural Optimized Research and Intelligence Assistant. NORIA provides instant answers on visas, universities, work permits, and global opportunities. NORIA can analyse documents for completeness and provide personalised step-by-step guidance. NORIA is trained on comprehensive immigration law, visa policy, scholarship databases, and global mobility data. For complex cases, NORIA recommends speaking with a SkyGlobe human expert.`,
  },
]

export async function seedKnowledge() {
  console.log('NORIA: seeding baseline knowledge...')
  const allDocs = [...SKYGLOBE_SEED, ...AFRICA_KNOWLEDGE]
  const results = await ingestDocuments(allDocs)
  for (const r of results) console.log(`  ✓ ${r.source}: ${r.chunks} chunks`)
  console.log('NORIA: seed complete.')
}
