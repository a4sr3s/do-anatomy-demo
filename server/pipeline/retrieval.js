/**
 * Retrieval helpers shared by the web backend (server/pipeline/real.js) and
 * the MCP tool server (mcp/). Everything that touches Managed Postgres /
 * pgvector or embeds a query lives here so both processes use exactly the
 * same embedding and the same cosine search.
 */
import { embedLocal, LOCAL_DIM } from './embedding.js';

export const SCORE_FLOOR = 0.08;
/** The one answer for "nothing stored matches": used by the MCP tool text, both prompts and the app-side guard. */
export const DONT_KNOW_TEXT = 'I do not know that yet.';
/** search_facts result when no chunk clears SCORE_FLOOR: a plain marker the model can act on without reasoning. */
export const NO_MATCHING_FACTS = `NO_MATCHING_FACTS: answer exactly "${DONT_KNOW_TEXT}"`;

/**
 * Build the `pg.Pool` config for DATABASE_URL.
 *
 * pg >= 8.x treats `sslmode=require` (and `prefer` / `verify-ca`) in the
 * connection string as `verify-full`, and the parsed connection string wins
 * over an explicit `ssl` option. Against DigitalOcean Managed Postgres, whose
 * server certificate is signed by a per-cluster CA, that fails with
 * "self-signed certificate in certificate chain". So the sslmode parameter is
 * stripped here and TLS is configured explicitly:
 *   - DATABASE_CA_CERT set   -> verify the chain against that CA (secure)
 *   - otherwise, sslmode=prefer / require / verify-* -> TLS without chain verification
 *   - no sslmode (or disable) -> leave ssl to pg's defaults / PGSSLMODE
 * DATABASE_CA_CERT may contain literal "\n" sequences (App Platform secrets
 * are single-line), which are converted back to newlines.
 */
export function pgPoolConfig(databaseUrl, caCert) {
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    return { connectionString: databaseUrl };
  }
  const sslmode = url.searchParams.get('sslmode');
  url.searchParams.delete('sslmode');
  const connectionString = url.toString();
  const ca = typeof caCert === 'string' && caCert.trim() ? caCert.trim().replace(/\\n/g, '\n') : '';
  if (ca) return { connectionString, ssl: { ca, rejectUnauthorized: true } };
  if (sslmode && /^(prefer|require|verify-ca|verify-full)$/.test(sslmode)) return { connectionString, ssl: { rejectUnauthorized: false } };
  if (sslmode === 'disable') return { connectionString, ssl: false };
  return { connectionString };
}

/** Embedding configuration from env: local hash embedder unless DO_EMBEDDING_MODEL is set. */
export function embeddingConfig(env) {
  const embeddingModel = env.DO_EMBEDDING_MODEL || '';
  return {
    url: (env.DO_INFERENCE_URL || 'https://inference.do-ai.run/v1').replace(/\/$/, ''),
    key: env.DO_INFERENCE_KEY,
    embeddingModel,
    dim: Number(env.VECTOR_DIM) || (embeddingModel ? 1024 : LOCAL_DIM),
  };
}

/** Embed texts with the SAME embedder ingest used (local hash or Serverless Inference /embeddings). */
export async function embedTexts(cfg, texts, fetchImpl = (...a) => fetch(...a)) {
  if (!cfg.embeddingModel) return texts.map((t) => embedLocal(t, cfg.dim));
  const res = await fetchImpl(`${cfg.url}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({ model: cfg.embeddingModel, input: texts }),
  });
  if (!res.ok) throw new Error(`Embedding request failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

export function toVector(arr) {
  return `[${arr.map((x) => Number(x).toFixed(6)).join(',')}]`;
}

/**
 * Cosine top-k search over `table`. `queryable` is anything with
 * `.query(sql, params)` (a pg.Pool or a stub). Rows below SCORE_FLOOR are
 * dropped. Returns [{ id, object_key, chunk, score }].
 */
export async function cosineSearch(queryable, table, qvec, k = 3) {
  const limit = Math.max(1, Math.min(Number(k) || 3, 5));
  const r = await queryable.query(
    `SELECT id, chunk, object_key, 1 - (embedding <=> $1::vector) AS score FROM ${table} ORDER BY embedding <=> $1::vector LIMIT ${limit}`,
    [toVector(qvec)]
  );
  return r.rows
    .filter((x) => x.score > SCORE_FLOOR)
    .map((x) => ({ id: x.id, object_key: x.object_key ?? null, chunk: x.chunk, score: Number(Number(x.score).toFixed(3)) }));
}

/** Lazily create a pg.Pool for DATABASE_URL (no schema setup; the web service owns the table). */
export async function createPool(env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL missing');
  const pg = await import('pg');
  const Pool = pg.default?.Pool || pg.Pool;
  return new Pool(pgPoolConfig(env.DATABASE_URL, env.DATABASE_CA_CERT));
}
