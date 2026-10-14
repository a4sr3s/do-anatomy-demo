/**
 * Embedding migration for the pgvector table, shared by the web service (run
 * at boot from server/pipeline/real.js) and scripts/migrate-embeddings.js.
 *
 * Idempotent:
 *   - if the `embedding` column's declared dimension differs from the
 *     configured one (VECTOR_DIM / the embedding model), or `force` is set, the
 *     column is dropped and re-added as vector(dim) in ONE `ALTER TABLE`
 *     statement (atomic; a pg.Pool cannot promise a multi-statement
 *     transaction on one connection), which leaves every embedding NULL;
 *   - every row whose embedding IS NULL is then re-embedded with the
 *     configured embedder in batches and UPDATEd, so an interrupted run simply
 *     resumes on the next one and a matching table with no NULLs is a no-op.
 *
 * Rows with a NULL embedding never match a search (their cosine score is NULL),
 * so searches stay correct while the migration is in progress.
 */
const BATCH = 16;

/** `vector(1024)` -> 1024; anything else -> null. */
export function parseVectorDim(formatType) {
  const m = /^vector\((\d+)\)$/i.exec(String(formatType || '').trim());
  return m ? Number(m[1]) : null;
}

/** Declared dimension of `table.embedding` (null when the column or table is missing). */
export async function currentDim(queryable, table) {
  const r = await queryable.query(
    'SELECT format_type(a.atttypid, a.atttypmod) AS type FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relname = $1 AND a.attname = $2 AND NOT a.attisdropped',
    [table, 'embedding']
  );
  const row = r.rows && r.rows[0];
  return row ? { exists: true, dim: parseVectorDim(row.type), type: row.type } : { exists: false, dim: null, type: null };
}

const vec = (arr) => `[${arr.map((x) => Number(x).toFixed(6)).join(',')}]`;

/**
 * Run the migration. `queryable` has `.query(sql, params)` (pg.Pool or a
 * stub); `cfg` is `embeddingConfig(env)` (only `dim` and `embeddingModel`
 * are read); `embedFn(texts)` resolves one vector per text.
 * Resolves { table, dim, previousDim, recreated, facts, rows, reembedded, ms }.
 */
export async function migrate(queryable, cfg, embedFn, { table = 'anatomy_chunks', force = false, log = console, batchSize = BATCH } = {}) {
  const t0 = Date.now();
  const dim = Number(cfg.dim);
  if (!Number.isInteger(dim) || dim <= 0) throw new Error(`invalid embedding dimension ${cfg.dim}`);
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error(`invalid table name ${table}`);
  const col = await currentDim(queryable, table);
  if (!col.exists) throw new Error(`table ${table} has no embedding column (does it exist?)`);
  const previousDim = col.dim;
  const recreated = force || previousDim !== dim;
  if (recreated) {
    log.log?.(`[migrate] ${table}.embedding is ${col.type}, want vector(${dim})${force ? ' (forced)' : ''}: recreating the column`);
    await queryable.query(`ALTER TABLE ${table} DROP COLUMN embedding, ADD COLUMN embedding vector(${dim})`);
  }
  const pending = await queryable.query(`SELECT id, chunk FROM ${table} WHERE embedding IS NULL ORDER BY id`);
  const todo = pending.rows || [];
  let reembedded = 0;
  for (let i = 0; i < todo.length; i += batchSize) {
    const batch = todo.slice(i, i + batchSize);
    const vectors = await embedFn(batch.map((r) => r.chunk));
    if (!Array.isArray(vectors) || vectors.length !== batch.length) throw new Error(`embedder returned ${vectors?.length} vectors for ${batch.length} texts`);
    for (let j = 0; j < batch.length; j++) {
      const v = vectors[j];
      if (!Array.isArray(v) || v.length !== dim) throw new Error(`embedder returned ${v?.length} dims, table is vector(${dim}) (check VECTOR_DIM / DO_EMBEDDING_MODEL)`);
      await queryable.query(`UPDATE ${table} SET embedding = $1::vector WHERE id = $2`, [vec(v), batch[j].id]);
      reembedded++;
    }
    log.log?.(`[migrate] re-embedded ${reembedded}/${todo.length} rows (${cfg.embeddingModel || 'local-hash'}, ${dim} dims)`);
  }
  const counts = await queryable.query(`SELECT count(*)::int AS rows, count(DISTINCT object_key)::int AS facts FROM ${table}`);
  const c = (counts.rows && counts.rows[0]) || { rows: 0, facts: 0 };
  const out = { table, dim, previousDim, recreated, facts: Number(c.facts) || 0, rows: Number(c.rows) || 0, reembedded, ms: Date.now() - t0 };
  log.log?.(`[migrate] facts=${out.facts} rows=${out.rows} dim=${out.dim}${recreated ? ` (was ${previousDim ?? 'unknown'})` : ''} re-embedded=${reembedded} in ${out.ms} ms`);
  return out;
}
