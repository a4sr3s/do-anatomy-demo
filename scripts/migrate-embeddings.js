#!/usr/bin/env node
// Re-embed the pgvector table for the configured embedding model.
//
//   DATABASE_URL=... DO_EMBEDDING_MODEL=bge-m3 VECTOR_DIM=1024 DO_INFERENCE_KEY=... \
//     npm run migrate:embeddings [-- --force]
//
// Idempotent: the `embedding` column is only recreated when its dimension differs
// from VECTOR_DIM (or with --force); rows whose embedding is NULL are always
// re-embedded, so an interrupted run resumes. The web service runs the same
// migration at boot (server/pipeline/real.js), this script is for running it by
// hand from a box that can reach the database.
import { migrate } from '../server/pipeline/migrate.js';
import { createPool, embeddingConfig, embedTexts } from '../server/pipeline/retrieval.js';

const env = process.env;
const force = process.argv.includes('--force');
if (!env.DATABASE_URL) {
  console.error('DATABASE_URL missing');
  process.exit(2);
}
const cfg = embeddingConfig(env);
if (cfg.embeddingModel && !cfg.key) {
  console.error(`DO_EMBEDDING_MODEL=${cfg.embeddingModel} needs DO_INFERENCE_KEY (or HARNESS_INFERENCE_API_KEY)`);
  process.exit(2);
}
const table = env.PGVECTOR_TABLE || 'anatomy_chunks';
const pool = await createPool(env);
try {
  console.log(`[migrate] table=${table} embedder=${cfg.embeddingModel || 'local-hash'} dim=${cfg.dim}${force ? ' --force' : ''}`);
  const out = await migrate(pool, cfg, (texts) => embedTexts(cfg, texts), { table, force });
  console.log(JSON.stringify(out));
} catch (err) {
  console.error(`[migrate] failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
