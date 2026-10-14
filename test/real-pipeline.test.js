import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../server/bus.js';
import { RealPipeline, pgPoolConfig } from '../server/pipeline/real.js';

const FACT = 'Acme Robotics runs 40 GPU droplets in SFO3.';

/** Build a RealPipeline with pgvector stubbed out (no harness, no network). */
function setup(env, { rows = [{ id: 7, chunk: FACT, score: 0.91 }] } = {}) {
  const bus = new EventBus();
  const events = [];
  bus.on('event', (e) => events.push(e));
  const p = new RealPipeline(bus, { DATABASE_URL: 'postgres://stub', ...env });
  p.count = rows.length;
  p.db = async () => ({ query: async () => ({ rows }) });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`unexpected fetch ${url}`);
  };
  return { p, events, restore: () => (globalThis.fetch = realFetch) };
}

const stageSeq = (events, status) => events.filter((e) => e.type === 'stage' && e.status === status).map((e) => e.stage);

test('real pipeline: describe() reports the harness as the only way to the model; no agent / answerBackend fields', () => {
  const bus = new EventBus();
  const withToken = new RealPipeline(bus, { HARNESS_API_TOKEN: 't' }).describe();
  assert.equal(withToken.inferenceVia, 'harness');
  assert.equal(withToken.harness, true);
  assert.equal(new RealPipeline(bus, { DIGITALOCEAN_ACCESS_TOKEN: 'dop' }).describe().inferenceVia, 'harness');
  const none = new RealPipeline(bus, {}).describe();
  assert.equal(none.inferenceVia, null);
  assert.equal(none.harness, false);
  // the legacy Managed Agent / direct Serverless Inference backends are gone
  for (const d of [withToken, none]) {
    assert.ok(!('agent' in d), 'no agent flag');
    assert.ok(!('answerBackend' in d), 'no answerBackend');
  }
  assert.equal(new RealPipeline(bus, { DO_AGENT_ENDPOINT: 'https://x.agents.do-ai.run/', DO_AGENT_KEY: 'k', ANSWER_BACKEND: 'agent' }).describe().inferenceVia, null, 'DO_AGENT_* / ANSWER_BACKEND are ignored');
  assert.equal(new RealPipeline(bus, { DO_INFERENCE_KEY: 'k', ANSWER_MODE: 'tool' }).describe().inferenceVia, null, 'on the tool path a Model Access Key alone does not answer questions');
  assert.equal(new RealPipeline(bus, { DO_INFERENCE_KEY: 'k' }).describe().inferenceVia, 'direct', 'the default search-first/direct path answers with the inference key alone');
  assert.equal(typeof RealPipeline.prototype.askAgent, 'undefined');
  assert.equal(typeof RealPipeline.prototype.streamChat, 'undefined');
});

test('real pipeline: without a harness token a tool-path question fails with a clear error that triggers replay fallback; search-first needs its key too', async () => {
  const { p, events, restore } = setup({ DO_AGENT_ENDPOINT: 'https://x.agents.do-ai.run/', DO_AGENT_KEY: 'k', DO_INFERENCE_KEY: 'k', ANSWER_MODE: 'tool' });
  try {
    await assert.rejects(p.ask('anything'), /HARNESS_API_TOKEN missing/);
    assert.equal(events.at(-1).type, 'job');
    assert.equal(events.at(-1).status, 'error');
    assert.equal(stageSeq(events, 'start').length, 0, 'fails before touching the database or any network');
    // search-first via the harness: same requirement; direct: the inference key
    await assert.rejects(p.ask('anything', { mode: 'search-first', backend: 'harness' }), /HARNESS_API_TOKEN missing .*SEARCH_FIRST_BACKEND=harness/);
    const noKey = setup({});
    try {
      await assert.rejects(noKey.p.ask('anything'), /HARNESS_INFERENCE_API_KEY missing .*SEARCH_FIRST_BACKEND=direct/);
      assert.equal(stageSeq(noKey.events, 'start').length, 0);
    } finally {
      noKey.restore();
    }
  } finally {
    restore();
  }
});

test('real pipeline: submitFact chunks + embeds inside the app (stage `functions` stays the wire name, no DO Function call)', async () => {
  const bus = new EventBus();
  const events = [];
  bus.on('event', (e) => events.push(e));
  const p = new RealPipeline(bus, { DATABASE_URL: 'postgres://stub', DO_SPACES_BUCKET: 'anatomy-bucket', DO_SPACES_KEY: 'k', DO_SPACES_SECRET: 's', DO_FUNCTION_URL: 'https://faas.example/ignored' });
  const inserts = [];
  p.db = async () => ({ query: async (sql, params) => { if (sql.startsWith('INSERT')) inserts.push(params); return { rows: [] }; } });
  const sent = [];
  p.s3 = async () => ({ send: async (cmd) => { sent.push(cmd.constructor.name); return {}; } });
  const realFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url) => { fetched.push(String(url)); throw new Error('no network expected'); };
  try {
    const out = await p.submitFact(FACT);
    assert.equal(out.chunks, 1);
    assert.equal(inserts.length, 1);
    assert.deepEqual(sent, ['PutObjectCommand']);
    assert.deepEqual(fetched, [], 'DO_FUNCTION_URL is not a thing any more: nothing is fetched');
    assert.deepEqual(stageSeq(events, 'start'), ['spaces', 'functions', 'vectordb']);
    const fn = events.find((e) => e.stage === 'functions' && e.status === 'start');
    assert.match(fn.detail, /App Platform: chunk \+ embed in-process/);
    assert.equal(fn.data.where, 'app-platform');
    const steps = events.filter((e) => e.stage === 'functions' && e.status === 'progress').map((e) => e.data.step);
    assert.deepEqual(steps, ['chunk', 'embed']);
    assert.match(events.find((e) => e.stage === 'functions' && e.status === 'progress' && e.data.step === 'embed').detail, /128 dims/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

const DO_URL = 'postgresql://doadmin:p%40ss@db-postgresql-nyc3-1-do-user-1.b.db.ondigitalocean.com:25060/defaultdb?sslmode=require';

test('pgPoolConfig: sslmode=require is stripped and TLS runs without chain verification when no CA is given', () => {
  const cfg = pgPoolConfig(DO_URL, undefined);
  assert.doesNotMatch(cfg.connectionString, /sslmode/);
  assert.match(cfg.connectionString, /^postgresql:\/\/doadmin:p%40ss@db-postgresql-nyc3-1-do-user-1\.b\.db\.ondigitalocean\.com:25060\/defaultdb$/);
  assert.deepEqual(cfg.ssl, { rejectUnauthorized: false });
  assert.deepEqual(pgPoolConfig(DO_URL.replace('require', 'verify-full'), '').ssl, { rejectUnauthorized: false });
  assert.deepEqual(pgPoolConfig(DO_URL.replace('require', 'verify-ca'), '  ').ssl, { rejectUnauthorized: false });
});

test('pgPoolConfig: DATABASE_CA_CERT enables verification and accepts literal \\n sequences', () => {
  const pem = '-----BEGIN CERTIFICATE-----\nMIIB\nAAA=\n-----END CERTIFICATE-----';
  const cfg = pgPoolConfig(DO_URL, pem);
  assert.doesNotMatch(cfg.connectionString, /sslmode/);
  assert.equal(cfg.ssl.rejectUnauthorized, true);
  assert.equal(cfg.ssl.ca, '-----BEGIN CERTIFICATE-----\nMIIB\nAAA=\n-----END CERTIFICATE-----');
  // real newlines pass through unchanged
  assert.equal(pgPoolConfig(DO_URL, '-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n').ssl.ca, '-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----');
});

test('pgPoolConfig: other parameters survive, sslmode=disable turns TLS off, no sslmode leaves pg defaults', () => {
  const cfg = pgPoolConfig('postgres://u:p@localhost:5432/db?application_name=demo&sslmode=require', '');
  assert.equal(cfg.connectionString, 'postgres://u:p@localhost:5432/db?application_name=demo');
  assert.deepEqual(pgPoolConfig('postgres://u:p@localhost/db?sslmode=disable', ''), { connectionString: 'postgres://u:p@localhost/db', ssl: false });
  assert.deepEqual(pgPoolConfig('postgres://u:p@localhost/db', ''), { connectionString: 'postgres://u:p@localhost/db' });
  assert.deepEqual(pgPoolConfig('not a url', ''), { connectionString: 'not a url' });
});

test('pgPoolConfig: pg honours the explicit ssl option once sslmode is gone from the connection string', async () => {
  const pg = await import('pg');
  const Client = pg.default?.Client || pg.Client;
  // Client parses the connection string at construction time (no connect needed).
  const client = new Client(pgPoolConfig(DO_URL, ''));
  assert.deepEqual(client.ssl, { rejectUnauthorized: false });
  assert.equal(client.host, 'db-postgresql-nyc3-1-do-user-1.b.db.ondigitalocean.com');
  assert.equal(client.port, 25060);
  assert.equal(client.user, 'doadmin');
  assert.equal(client.password, 'p@ss');
  assert.equal(client.database, 'defaultdb');

  const verified = new Client(pgPoolConfig(DO_URL, '-----BEGIN CERTIFICATE-----\\nAAA=\\n-----END CERTIFICATE-----'));
  assert.equal(verified.ssl.rejectUnauthorized, true);
  assert.equal(verified.ssl.ca, '-----BEGIN CERTIFICATE-----\nAAA=\n-----END CERTIFICATE-----');

  // The bug being fixed: with sslmode=require left in the URL, pg ignores the ssl option (treats it as verify-full).
  const buggy = new Client({ connectionString: DO_URL, ssl: { rejectUnauthorized: false } });
  assert.notDeepEqual(buggy.ssl, { rejectUnauthorized: false });
});

/** RealPipeline with a scripted pg pool (records SQL) and a fake S3 client (records commands). */
function setupFacts(rowsByQuery) {
  const bus = new EventBus();
  const events = [];
  bus.on('event', (e) => events.push(e));
  const p = new RealPipeline(bus, { DATABASE_URL: 'postgres://stub', DO_SPACES_BUCKET: 'anatomy-bucket', DO_SPACES_KEY: 'k', DO_SPACES_SECRET: 's', PGVECTOR_TABLE: 'demo_chunks' });
  const queries = [];
  p.db = async () => ({
    query: async (sql, params) => {
      queries.push({ sql, params });
      for (const [re, rows] of rowsByQuery) if (re.test(sql)) return { rows: typeof rows === 'function' ? rows(params) : rows, rowCount: rows.length };
      return { rows: [], rowCount: 0 };
    },
  });
  const sent = [];
  p.s3 = async () => ({ send: async (cmd) => { sent.push({ name: cmd.constructor.name, input: cmd.input }); return {}; } });
  return { p, events, queries, sent };
}

test('real pipeline: listFacts groups pgvector rows per Spaces object, newest first', async () => {
  const { p, queries } = setupFacts([
    [/SELECT object_key AS key, count/, [
      { key: 'facts/1760-bbbb.txt', chunks: 2, created_at: new Date('2026-10-12T15:00:00Z'), first_id: 8, text: 'Second fact part one. Second fact part two.' },
      { key: 'facts/1760-aaaa.txt', chunks: 1, created_at: new Date('2026-10-12T14:00:00Z'), first_id: 7, text: FACT },
    ]],
  ]);
  const facts = await p.listFacts();
  assert.deepEqual(facts, [
    { id: '1760-bbbb', key: 'facts/1760-bbbb.txt', text: 'Second fact part one. Second fact part two.', createdAt: Date.parse('2026-10-12T15:00:00Z'), chunks: 2 },
    { id: '1760-aaaa', key: 'facts/1760-aaaa.txt', text: FACT, createdAt: Date.parse('2026-10-12T14:00:00Z'), chunks: 1 },
  ]);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /FROM demo_chunks WHERE object_key IS NOT NULL GROUP BY object_key ORDER BY min\(id\) DESC/);
  assert.match(queries[0].sql, /string_agg\(chunk, ' ' ORDER BY id\)/);
});

test('real pipeline: deleteFact deletes the rows by object_key (parameterised), recounts, then deletes the Spaces object', async () => {
  const { p, events, queries, sent } = setupFacts([
    [/^SELECT id FROM demo_chunks WHERE object_key = \$1/, [{ id: 7 }, { id: 8 }]],
    [/^DELETE FROM demo_chunks WHERE object_key = \$1 RETURNING id$/, [{ id: 7 }, { id: 8 }]],
    [/^SELECT count\(\*\)::int AS n FROM demo_chunks$/, [{ n: 3 }]],
  ]);
  const out = await p.deleteFact('1760-aaaa');
  assert.equal(out.key, 'facts/1760-aaaa.txt');
  assert.equal(out.id, '1760-aaaa');
  assert.equal(out.removed, 2);
  assert.equal(out.total, 3);
  assert.equal(p.count, 3);
  assert.deepEqual(queries.map((q) => q.params), [['facts/1760-aaaa.txt'], ['facts/1760-aaaa.txt'], undefined]);
  assert.ok(queries.every((q) => !q.sql.includes('1760-aaaa')), 'the key only ever travels as a bind parameter');
  assert.deepEqual(sent, [{ name: 'DeleteObjectCommand', input: { Bucket: 'anatomy-bucket', Key: 'facts/1760-aaaa.txt' } }]);
  assert.deepEqual(stageSeq(events, 'start'), ['vectordb', 'spaces']);
  assert.deepEqual(stageSeq(events, 'done'), ['vectordb', 'spaces']);
  assert.ok(events.every((e) => e.flow === 'delete'));
  const vdone = events.find((e) => e.stage === 'vectordb' && e.status === 'done');
  assert.deepEqual(vdone.data, { op: 'delete', key: 'facts/1760-aaaa.txt', ids: [7, 8], removed: 2, count: 3 });
  assert.equal(events.at(-1).type, 'job');
  assert.equal(events.at(-1).status, 'done');

  // a full key works as the id too; an unknown fact is a 404 before any job starts
  await p.deleteFact('facts/1760-aaaa.txt');
  assert.equal(sent.length, 2);
  const before = events.length;
  const { p: p2 } = setupFacts([]);
  await assert.rejects(p2.deleteFact('ghost'), (err) => err.status === 404);
  assert.equal(events.length, before);
});

test('real pipeline: deleteAllFacts removes every row (known keys + legacy rows) and the objects in one DeleteObjects batch', async () => {
  const { p, events, queries, sent } = setupFacts([
    [/^SELECT DISTINCT object_key AS key FROM demo_chunks/, [{ key: 'facts/1.txt' }, { key: 'facts/2.txt' }]],
    [/^SELECT id FROM demo_chunks ORDER BY id$/, [{ id: 1 }, { id: 2 }, { id: 3 }]],
    [/^DELETE FROM demo_chunks WHERE object_key = ANY\(\$1::text\[\]\) OR object_key IS NULL RETURNING id$/, [{ id: 1 }, { id: 2 }, { id: 3 }]],
    [/^SELECT count\(\*\)::int AS n FROM demo_chunks$/, [{ n: 0 }]],
  ]);
  const out = await p.deleteAllFacts();
  assert.deepEqual({ facts: out.facts, removed: out.removed, total: out.total }, { facts: 2, removed: 3, total: 0 });
  const del = queries.find((q) => q.sql.startsWith('DELETE'));
  assert.deepEqual(del.params, [['facts/1.txt', 'facts/2.txt']]);
  assert.deepEqual(sent, [{ name: 'DeleteObjectsCommand', input: { Bucket: 'anatomy-bucket', Delete: { Objects: [{ Key: 'facts/1.txt' }, { Key: 'facts/2.txt' }], Quiet: true } } }]);
  assert.deepEqual(stageSeq(events, 'done'), ['vectordb', 'spaces']);
  assert.equal(events.find((e) => e.type === 'job').data.all, true);

  // nothing stored: no DeleteObjects call, still a clean job
  const empty = setupFacts([[/^SELECT count/, [{ n: 0 }]]]);
  const none = await empty.p.deleteAllFacts();
  assert.deepEqual({ facts: none.facts, removed: none.removed }, { facts: 0, removed: 0 });
  assert.equal(empty.sent.length, 0);
});

test('real pipeline: search floor and inference key follow the embedder config', () => {
  const bus = new EventBus();
  const local = new RealPipeline(bus, {});
  assert.equal(local.cfg.scoreFloor, 0.08);
  assert.equal(local.describe().scoreFloor, 0.08);
  assert.equal(local.describe().vectorDim, 128);
  const hosted = new RealPipeline(bus, { DO_EMBEDDING_MODEL: 'bge-m3', HARNESS_INFERENCE_API_KEY: 'h' });
  assert.equal(hosted.cfg.scoreFloor, 0.52);
  assert.equal(hosted.describe().vectorDim, 1024);
  assert.equal(hosted.describe().inference, true, 'the harness inference key serves /embeddings too');
  assert.equal(hosted.cfg.embedding.key, 'h');
});

test('real pipeline: db() runs the embedding migration after CREATE TABLE; errors are recorded, never thrown; the MCP server never migrates', async () => {
  const bus = new EventBus();
  const makePool = (type, rows) => {
    const pool = { queries: [], type, rows: rows.map((r) => ({ ...r })) };
    pool.query = async (sql, params = []) => {
      pool.queries.push(sql);
      if (/pg_attribute/.test(sql)) return { rows: [{ type: pool.type }] };
      if (/^ALTER TABLE/.test(sql)) { pool.type = 'vector(1024)'; for (const r of pool.rows) r.embedding = null; return { rows: [] }; }
      if (/WHERE embedding IS NULL/.test(sql)) return { rows: pool.rows.filter((r) => r.embedding == null) };
      if (/^UPDATE/.test(sql)) { pool.rows.find((r) => r.id === params[1]).embedding = params[0]; return {}; }
      if (/count\(DISTINCT object_key\)/.test(sql)) return { rows: [{ rows: pool.rows.length, facts: new Set(pool.rows.map((r) => r.object_key)).size }] };
      if (/count\(\*\)::int AS n/.test(sql)) return { rows: [{ n: pool.rows.length }] };
      return { rows: [] };
    };
    pool.end = async () => {};
    return pool;
  };
  const logs = [];
  const log = { log: (m) => logs.push(m), error: (m) => logs.push(`ERR ${m}`) };
  // stub pg so no network is touched
  const p = new RealPipeline(bus, { DATABASE_URL: 'postgres://stub', DO_EMBEDDING_MODEL: 'bge-m3', DO_INFERENCE_KEY: 'k' });
  const pool = makePool('vector(128)', [{ id: 1, chunk: 'a', object_key: 'facts/1.txt', embedding: '[old]' }, { id: 2, chunk: 'b', object_key: 'facts/2.txt', embedding: '[old]' }]);
  p.embed = async (texts) => texts.map(() => new Array(1024).fill(0.5));
  const origMigrate = p.migrateEmbeddings.bind(p);
  p.migrateEmbeddings = (pl) => origMigrate(pl, log);
  const realDb = p.db;
  p.db = async function () {
    if (this._pool) return this._pool;
    this._pool = pool;
    this._ready = (async () => {
      await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
      await pool.query(`CREATE TABLE IF NOT EXISTS ${this.cfg.table} (...)`);
      await this.migrateEmbeddings(pool);
      const r = await pool.query(`SELECT count(*)::int AS n FROM ${this.cfg.table}`);
      this.count = r.rows[0].n;
    })();
    await this._ready;
    return pool;
  };
  assert.equal(p.migration, null, 'nothing before the first db() call');
  const out = await p.prepareDb(log);
  assert.equal(out.ok, true);
  assert.equal(p.migration.ok, true);
  assert.deepEqual({ facts: p.migration.facts, rows: p.migration.rows, dim: p.migration.dim, previousDim: p.migration.previousDim, recreated: p.migration.recreated, reembedded: p.migration.reembedded, embedding: p.migration.embedding }, { facts: 2, rows: 2, dim: 1024, previousDim: 128, recreated: true, reembedded: 2, embedding: 'bge-m3' });
  assert.ok(logs.some((m) => /^\[migrate\] facts=2 rows=2 dim=1024/.test(m)), logs.join('\n'));
  assert.ok(pool.queries.findIndex((q) => /CREATE TABLE/.test(q)) < pool.queries.findIndex((q) => /pg_attribute/.test(q)), 'migration runs after CREATE TABLE');
  assert.equal(p.count, 2);
  assert.equal(typeof realDb, 'function');

  // a failing migration is recorded and logged but db() still resolves
  const bad = new RealPipeline(bus, { DATABASE_URL: 'postgres://stub' });
  const badPool = { query: async (sql) => { if (/pg_attribute/.test(sql)) throw new Error('permission denied for pg_attribute'); return { rows: [{ n: 0 }] }; }, end: async () => {} };
  await bad.migrateEmbeddings(badPool, log);
  assert.equal(bad.migration.ok, false);
  assert.match(bad.migration.error, /permission denied/);
  assert.match(logs.at(-1), /^ERR \[migrate\] failed: permission denied/);

  // no DATABASE_URL -> skipped, never throws
  assert.deepEqual(await new RealPipeline(bus, {}).prepareDb(log), { ok: false, skipped: true, reason: 'DATABASE_URL not set' });

  // the MCP server has no migration code path
  const mcpSrc = await import('node:fs').then((fs) => fs.readFileSync(new URL('../mcp/server.js', import.meta.url), 'utf8'));
  assert.ok(!/migrate/.test(mcpSrc), 'mcp/server.js never imports or runs the migration');
});
