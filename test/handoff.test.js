import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { createMcpApp } from '../mcp/server.js';
import {
  handoffConfig,
  mintHandoffToken,
  signSessionToken,
  DEMO_SESSION_COOKIE,
  DEMO_HUB_URL,
} from '../server/handoff.js';

const SECRET = 'test-handoff-secret-at-least-32-chars!!';

test('handoff: production without secret fails closed (health open, API 401, pages redirect)', async () => {
  const recordingsDir = mkdtempSync(path.join(tmpdir(), 'anatomy-handoff-'));
  const { app } = await createApp({
    env: { NODE_ENV: 'production', MCP_AUTH_TOKEN: 'mcp' },
    handoffGate: true,
    pipelineOverrides: { mode: 'mock', delayScale: 0 },
    recordingsDir,
    autoCapture: false,
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
    const page = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), DEMO_HUB_URL);
    const handoff = await fetch(`${base}/auth/handoff?token=bad`, { redirect: 'manual' });
    assert.equal(handoff.status, 302);
    assert.equal(handoff.headers.get('location'), DEMO_HUB_URL);
  } finally {
    server.close();
  }
});

test('handoff: valid token sets demo_session and unlocks the app', async () => {
  const cfg = handoffConfig({ DEMO_HANDOFF_SECRET: SECRET });
  const recordingsDir = mkdtempSync(path.join(tmpdir(), 'anatomy-handoff-'));
  const { app } = await createApp({
    env: { DEMO_HANDOFF_SECRET: SECRET, MCP_AUTH_TOKEN: 'mcp' },
    handoffGate: true,
    pipelineOverrides: { mode: 'mock', delayScale: 0 },
    recordingsDir,
    autoCapture: false,
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const token = await mintHandoffToken(cfg);
    const hop = await fetch(`${base}/auth/handoff?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
    assert.equal(hop.status, 302);
    assert.equal(hop.headers.get('location'), '/');
    const setCookie = hop.headers.get('set-cookie') || '';
    assert.match(setCookie, /demo_session=/);
    const session = setCookie.split(';')[0].split('=').slice(1).join('=');
    const authed = await fetch(`${base}/api/ask/modes`, { headers: { cookie: `${DEMO_SESSION_COOKIE}=${session}` } });
    assert.equal(authed.status, 200);
    assert.match(authed.headers.get('x-robots-tag') || '', /noindex/i);
  } finally {
    server.close();
  }
});

test('handoff: internal tool-event bypasses demo gate with x-tool-event-token', async () => {
  const recordingsDir = mkdtempSync(path.join(tmpdir(), 'anatomy-handoff-'));
  const { app } = await createApp({
    env: { NODE_ENV: 'production', MCP_AUTH_TOKEN: 'mcp-secret' },
    handoffGate: true,
    pipelineOverrides: { mode: 'mock', delayScale: 0 },
    recordingsDir,
    autoCapture: false,
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/internal/tool-event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tool-event-token': 'mcp-secret' },
      body: '{}',
    });
    assert.notEqual(res.status, 401, 'demo gate must not block internal tool-event');
  } finally {
    server.close();
  }
});

test('mcp: production gate allows health and bearer, blocks anonymous /mcp', async () => {
  const { app } = createMcpApp({
    env: { NODE_ENV: 'production', MCP_AUTH_TOKEN: 'secret', VECTOR_DIM: '128' },
    deps: {
      query: async () => ({ rows: [] }),
      getObject: async () => ({ text: '', bytes: 0 }),
      fetch: async () => new Response('{}', { status: 200 }),
    },
    log: { warn() {}, error() {} },
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/mcp/health`)).status, 200);
    const rpc = {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    };
    assert.equal((await fetch(`${base}/mcp`, rpc)).status, 401);
    const cfg = handoffConfig({ DEMO_HANDOFF_SECRET: SECRET, NODE_ENV: 'production' });
    const session = await signSessionToken(cfg);
    const withCookie = await fetch(`${base}/mcp`, {
      ...rpc,
      headers: { ...rpc.headers, cookie: `${DEMO_SESSION_COOKIE}=${session}` },
    });
    assert.equal(withCookie.status, 401, 'MCP still requires bearer even with demo cookie');
    const withBearer = await fetch(`${base}/mcp`, {
      ...rpc,
      headers: { ...rpc.headers, authorization: 'Bearer secret' },
    });
    assert.notEqual(withBearer.status, 401);
  } finally {
    server.close();
  }
});
