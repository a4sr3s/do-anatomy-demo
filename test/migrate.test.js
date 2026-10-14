import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, parseVectorDim, currentDim } from '../server/pipeline/migrate.js';
import { embedLocal } from '../server/pipeline/embedding.js';

/**
 * In-memory stand-in for pg: understands exactly the statements migrate() issues
 * and keeps the rows + the declared column type so a run can be inspected.
 */
function fakeDb({ type = 'vector(128)', rows = [] } = {}) {
  const db = { type, rows: rows.map((r) => ({ ...r })), queries: [] };
  db.query = async (sql, params = []) => {
    db.queries.push({ sql, params });
    if (/FROM pg_attribute/.test(sql)) return { rows: db.type ? [{ type: db.type }] : [] };
    let m;
    if ((m = /^ALTER TABLE (\w+) DROP COLUMN embedding, ADD COLUMN embedding vector\((\d+)\)$/.exec(sql))) {
      db.type = `vector(${m[2]})`;
      for (const r of db.rows) r.embedding = null;
      return { rows: [] };
    }
    if (/^SELECT id, chunk FROM \w+ WHERE embedding IS NULL ORDER BY id$/.test(sql)) return { rows: db.rows.filter((r) => r.embedding == null).map(({ id, chunk }) => ({ id, chunk })) };
    if ((m = /^UPDATE \w+ SET embedding = \$1::vector WHERE id = \$2$/.exec(sql))) {
      const row = db.rows.find((r) => r.id === params[1]);
      row.embedding = params[0];
      return { rowCount: 1 };
    }
    if (/count\(DISTINCT object_key\)/.test(sql)) {
      const keys = new Set(db.rows.map((r) => r.object_key).filter((k) => k != null));
      return { rows: [{ rows: db.rows.length, facts: keys.size }] };
    }
    throw new Error(`unexpected sql: ${sql}`);
  };
  return db;
}

const silent = { log() {}, error() {} };
const ROWS = [
  { id: 1, chunk: 'Acme runs 40 GPU droplets in SFO3.', object_key: 'facts/1.txt', embedding: '[old]' },
  { id: 2, chunk: 'They use Spaces for backups.', object_key: 'facts/1.txt', embedding: '[old]' },
  { id: 3, chunk: 'Beta Corp is in AMS3.', object_key: 'facts/2.txt', embedding: '[old]' },
];

test('migrate: parses the pgvector column type', async () => {
  assert.equal(parseVectorDim('vector(1024)'), 1024);
  assert.equal(parseVectorDim('vector'), null);
  assert.equal(parseVectorDim('text'), null);
  assert.deepEqual(await currentDim(fakeDb({ type: 'vector(128)' }), 'anatomy_chunks'), { exists: true, dim: 128, type: 'vector(128)' });
  assert.deepEqual(await currentDim(fakeDb({ type: null }), 'anatomy_chunks'), { exists: false, dim: null, type: null });
});

test('migrate: a dimension mismatch recreates the column and re-embeds every row in batches of 16', async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, chunk: `chunk ${i + 1}`, object_key: `facts/${Math.floor(i / 4)}.txt`, embedding: '[old]' }));
  const db = fakeDb({ type: 'vector(128)', rows: many });
  const batches = [];
  const embedFn = async (texts) => {
    batches.push(texts.length);
    return texts.map((t) => embedLocal(t, 1024));
  };
  const out = await migrate(db, { dim: 1024, embeddingModel: 'bge-m3' }, embedFn, { table: 'anatomy_chunks', log: silent });
  assert.equal(db.type, 'vector(1024)');
  assert.deepEqual(batches, [16, 16, 8]);
  assert.ok(db.rows.every((r) => typeof r.embedding === 'string' && r.embedding.startsWith('[') && r.embedding.split(',').length === 1024), 'every row holds a 1024-dim vector literal');
  assert.deepEqual({ ...out, ms: undefined }, { table: 'anatomy_chunks', dim: 1024, previousDim: 128, recreated: true, facts: 10, rows: 40, reembedded: 40, ms: undefined });
  assert.ok(db.queries.some((q) => /ALTER TABLE anatomy_chunks DROP COLUMN embedding, ADD COLUMN embedding vector\(1024\)/.test(q.sql)), 'one atomic ALTER');
  assert.equal(db.queries[0].params[0], 'anatomy_chunks', 'looks the column up by table name');
});

test('migrate: idempotent: a matching column with no NULLs is a no-op; NULL rows are resumed; --force recreates anyway', async () => {
  const embedFn = async (texts) => texts.map((t) => embedLocal(t, 128));
  // no-op
  let db = fakeDb({ type: 'vector(128)', rows: ROWS });
  let out = await migrate(db, { dim: 128, embeddingModel: '' }, embedFn, { log: silent });
  assert.deepEqual({ recreated: out.recreated, reembedded: out.reembedded, facts: out.facts, rows: out.rows, previousDim: out.previousDim }, { recreated: false, reembedded: 0, facts: 2, rows: 3, previousDim: 128 });
  assert.ok(db.rows.every((r) => r.embedding === '[old]'), 'nothing touched');
  assert.ok(!db.queries.some((q) => /ALTER TABLE/.test(q.sql)));
  // resume: only the NULL row is embedded
  db = fakeDb({ type: 'vector(128)', rows: ROWS.map((r) => (r.id === 2 ? { ...r, embedding: null } : r)) });
  out = await migrate(db, { dim: 128, embeddingModel: '' }, embedFn, { log: silent });
  assert.equal(out.recreated, false);
  assert.equal(out.reembedded, 1);
  assert.equal(db.rows[0].embedding, '[old]');
  assert.notEqual(db.rows[1].embedding, null);
  // force
  db = fakeDb({ type: 'vector(128)', rows: ROWS });
  out = await migrate(db, { dim: 128, embeddingModel: '' }, embedFn, { force: true, log: silent });
  assert.equal(out.recreated, true);
  assert.equal(out.reembedded, 3);
  assert.ok(db.rows.every((r) => r.embedding !== '[old]'));
});

test('migrate: a wrong embedder dimension or missing table fails clearly, leaving NULL rows for the next run', async () => {
  const db = fakeDb({ type: 'vector(128)', rows: ROWS });
  await assert.rejects(migrate(db, { dim: 1024, embeddingModel: 'bge-m3' }, async (texts) => texts.map((t) => embedLocal(t, 128)), { log: silent }), /embedder returned 128 dims, table is vector\(1024\)/);
  assert.equal(db.type, 'vector(1024)', 'the column was recreated');
  assert.ok(db.rows.every((r) => r.embedding == null), 'rows stay NULL so the next run resumes');
  await assert.rejects(migrate(fakeDb({ type: null }), { dim: 128 }, async () => [], { log: silent }), /has no embedding column/);
  await assert.rejects(migrate(fakeDb(), { dim: 0 }, async () => [], { log: silent }), /invalid embedding dimension/);
  await assert.rejects(migrate(fakeDb(), { dim: 128 }, async () => [], { table: 'x; DROP', log: silent }), /invalid table name/);
});
