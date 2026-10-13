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
  assert.equal(new RealPipeline(bus, { DO_INFERENCE_KEY: 'k' }).describe().inferenceVia, null, 'a Model Access Key alone does not answer questions');
  assert.equal(typeof RealPipeline.prototype.askAgent, 'undefined');
  assert.equal(typeof RealPipeline.prototype.streamChat, 'undefined');
});

test('real pipeline: without a harness token a question fails with a clear error that triggers replay fallback', async () => {
  const { p, events, restore } = setup({ DO_AGENT_ENDPOINT: 'https://x.agents.do-ai.run/', DO_AGENT_KEY: 'k', DO_INFERENCE_KEY: 'k' });
  try {
    await assert.rejects(p.ask('anything'), /HARNESS_API_TOKEN missing/);
    assert.equal(events.at(-1).type, 'job');
    assert.equal(events.at(-1).status, 'error');
    assert.equal(stageSeq(events, 'start').length, 0, 'fails before touching the database or any network');
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
