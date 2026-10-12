import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpApp, tokenMatches, MAX_DOC_BYTES } from '../mcp/server.js';
import { embedLocal } from '../server/pipeline/embedding.js';

const FACT = 'Acme Robotics runs 40 GPU droplets in SFO3.';

/** MCP app with a fake database, a fake object store and a captured tool-event webhook. */
function start({ rows, objects = { 'facts/1.txt': FACT } } = {}) {
  const queries = [];
  const posted = [];
  const { app } = createMcpApp({
    env: { NODE_ENV: 'test', MCP_AUTH_TOKEN: 'secret', TOOL_EVENT_URL: 'http://web:8080/api/internal/tool-event', VECTOR_DIM: '128' },
    deps: {
      query: async (sql, params) => {
        queries.push({ sql, params });
        return { rows: rows ?? [{ id: 7, chunk: FACT, object_key: 'facts/1.txt', score: 0.91 }, { id: 8, chunk: 'noise', object_key: 'facts/2.txt', score: 0.01 }] };
      },
      getObject: async (key) => {
        if (!(key in objects)) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
        return { text: objects[key], bytes: objects[key].length };
      },
      fetch: async (url, init) => {
        posted.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
        return new Response('{"ok":true}', { status: 200 });
      },
    },
    log: { warn() {}, error() {} },
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, queries, posted, close: () => server.close() };
}

async function client(base, token = 'Bearer secret') {
  const c = new Client({ name: 'test', version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: token } } }));
  return c;
}

const settle = () => new Promise((r) => setTimeout(r, 30));

test('mcp: tokenMatches accepts Bearer and raw forms, rejects others in constant time', () => {
  assert.ok(tokenMatches('Bearer abc', 'abc'));
  assert.ok(tokenMatches('abc', 'abc'));
  assert.ok(!tokenMatches('Bearer abd', 'abc'));
  assert.ok(!tokenMatches('Bearer ab', 'abc'));
  assert.ok(!tokenMatches(undefined, 'abc'));
  assert.ok(!tokenMatches('', ''), 'an unset token never matches');
});

test('mcp: /mcp/health is open; /mcp requires the bearer token (401 for POST, GET and DELETE)', async () => {
  const { base, close } = start();
  try {
    const health = await (await fetch(`${base}/mcp/health`)).json();
    assert.equal(health.ok, true);
    assert.deepEqual(health.tools, ['search_facts', 'get_document']);
    const rpc = { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) };
    assert.equal((await fetch(`${base}/mcp`, rpc)).status, 401);
    assert.equal((await fetch(`${base}/mcp`, { ...rpc, headers: { ...rpc.headers, authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(`${base}/mcp`, { headers: { accept: 'text/event-stream' } })).status, 401);
    assert.equal((await fetch(`${base}/mcp`, { method: 'DELETE' })).status, 401);
    await assert.rejects(client(base, 'Bearer nope'));
  } finally {
    close();
  }
});

test('mcp: tools/list exposes search_facts and get_document with usable descriptions', async () => {
  const { base, close } = start();
  const c = await client(base);
  try {
    const { tools } = await c.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['get_document', 'search_facts']);
    const search = tools.find((t) => t.name === 'search_facts');
    assert.match(search.description, /pgvector/);
    assert.match(search.description, /Always call this before answering/);
    assert.deepEqual(Object.keys(search.inputSchema.properties).sort(), ['k', 'query']);
    assert.deepEqual(search.inputSchema.required, ['query']);
    assert.equal(search.inputSchema.properties.k.maximum, 5);
    const doc = tools.find((t) => t.name === 'get_document');
    assert.match(doc.description, /Spaces/);
    assert.deepEqual(doc.inputSchema.required, ['key']);
  } finally {
    await c.close();
    close();
  }
});

test('mcp: search_facts embeds like ingest, runs the cosine query, filters low scores and reports tool events', async () => {
  const { base, queries, posted, close } = start();
  const c = await client(base);
  try {
    const r = await c.callTool({ name: 'search_facts', arguments: { query: 'Where does Acme run?' } });
    assert.equal(r.isError, undefined);
    const hits = JSON.parse(r.content[0].text);
    assert.deepEqual(hits, [{ id: 7, object_key: 'facts/1.txt', chunk: FACT, score: 0.91 }], 'score 0.01 row filtered out');
    assert.deepEqual(r.structuredContent.hits, hits);
    assert.equal(queries.length, 1);
    assert.match(queries[0].sql, /ORDER BY embedding <=> \$1::vector LIMIT 3/);
    assert.match(queries[0].sql, /FROM anatomy_chunks/);
    const expected = `[${embedLocal('Where does Acme run?', 128).map((x) => x.toFixed(6)).join(',')}]`;
    assert.equal(queries[0].params[0], expected, 'same local hash embedding as ingest (VECTOR_DIM=128)');

    const r5 = await c.callTool({ name: 'search_facts', arguments: { query: 'q', k: 5 } });
    assert.equal(r5.isError, undefined);
    assert.match(queries[1].sql, /LIMIT 5/);
    const bad = await c.callTool({ name: 'search_facts', arguments: { query: 'q', k: 9 } });
    assert.equal(bad.isError, true, 'k > 5 is rejected by the schema');

    await settle();
    assert.equal(posted.length, 4);
    assert.ok(posted.every((p) => p.url === 'http://web:8080/api/internal/tool-event' && p.headers['x-tool-event-token'] === 'secret'));
    const [s, d] = posted;
    assert.equal(s.body.phase, 'start');
    assert.equal(s.body.tool, 'search_facts');
    assert.equal(s.body.target, 'pgvector');
    assert.deepEqual(s.body.args, { query: 'Where does Acme run?', k: 3 });
    assert.equal(d.body.phase, 'done');
    assert.equal(d.body.callId, s.body.callId);
    assert.equal(typeof d.body.ms, 'number');
    assert.equal(d.body.summary, '1 hit');
    assert.deepEqual(d.body.hits, [{ id: 7, score: 0.91, chunk: FACT, object_key: 'facts/1.txt' }]);
  } finally {
    await c.close();
    close();
  }
});

test('mcp: get_document reads facts/ objects only, caps at 8 KB, and reports errors as tool results', async () => {
  const big = 'x'.repeat(MAX_DOC_BYTES + 100);
  const { base, posted, close } = start({ objects: { 'facts/1.txt': FACT, 'facts/big.txt': big } });
  const c = await client(base);
  try {
    const ok = await c.callTool({ name: 'get_document', arguments: { key: 'facts/1.txt' } });
    assert.equal(ok.content[0].text, FACT);
    assert.equal(ok.structuredContent.key, 'facts/1.txt');
    const capped = await c.callTool({ name: 'get_document', arguments: { key: 'facts/big.txt' } });
    assert.equal(capped.content[0].text.length, MAX_DOC_BYTES);
    for (const key of ['secrets/x.txt', '../facts/1.txt', 'facts/../x', '']) {
      const r = await c.callTool({ name: 'get_document', arguments: { key } });
      assert.equal(r.isError, true, `key ${JSON.stringify(key)} rejected`);
    }
    const missing = await c.callTool({ name: 'get_document', arguments: { key: 'facts/none.txt' } });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /NoSuchKey/);

    await settle();
    const docEvents = posted.filter((p) => p.body.tool === 'get_document');
    assert.ok(docEvents.every((p) => p.body.target === 'spaces'));
    assert.equal(docEvents[0].body.phase, 'start');
    assert.equal(docEvents[1].body.phase, 'done');
    assert.equal(docEvents[1].body.summary, `${FACT.length} chars`);
    assert.ok(docEvents.some((p) => p.body.phase === 'error' && /only keys under facts\//.test(p.body.error)));
  } finally {
    await c.close();
    close();
  }
});

test('mcp: a failing or slow tool-event webhook never breaks the tool call', async () => {
  const { app } = createMcpApp({
    env: { NODE_ENV: 'test', MCP_AUTH_TOKEN: 'secret', TOOL_EVENT_URL: 'http://web:8080/api/internal/tool-event' },
    deps: {
      query: async () => ({ rows: [{ id: 1, chunk: 'c', object_key: null, score: 0.5 }] }),
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
    },
    log: { warn() {}, error() {} },
  });
  const server = app.listen(0);
  const c = await client(`http://127.0.0.1:${server.address().port}`);
  try {
    const r = await c.callTool({ name: 'search_facts', arguments: { query: 'q' } });
    assert.equal(r.isError, undefined);
    assert.equal(JSON.parse(r.content[0].text).length, 1);
  } finally {
    await c.close();
    server.close();
  }
});

test('mcp: raw JSON-RPC over POST works with the raw token (no Bearer prefix)', async () => {
  const { base, close } = start();
  try {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'secret' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.result.serverInfo.name, 'anatomy-data');
    assert.equal(res.headers.get('mcp-session-id'), null, 'stateless: no session id');
  } finally {
    close();
  }
});
