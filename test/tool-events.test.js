import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { EventBus } from '../server/bus.js';
import { Recorder } from '../server/recorder.js';
import { MockPipeline } from '../server/pipeline/mock.js';
import { RealPipeline } from '../server/pipeline/real.js';

const post = (base, body, token) =>
  fetch(`${base}/api/internal/tool-event`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-tool-event-token': token } : {}) }, body: JSON.stringify(body) });

test('tool-event endpoint: rejects missing/wrong token, accepts the right one, 202 in mock mode', async () => {
  const recordingsDir = mkdtempSync(path.join(tmpdir(), 'anatomy-rec-'));
  const { app } = await createApp({ env: { MCP_AUTH_TOKEN: 'secret', PIPELINE_MODE: 'mock', MOCK_DELAY_SCALE: '0' }, recordingsDir, autoCapture: false });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await post(base, { phase: 'done', tool: 'search_facts' })).status, 401);
    assert.equal((await post(base, { phase: 'done', tool: 'search_facts' }, 'wrong')).status, 401);
    assert.equal((await post(base, { phase: 'done', tool: 'search_facts' }, 'secre')).status, 401);
    const ok = await post(base, { phase: 'done', tool: 'search_facts' }, 'secret');
    assert.equal(ok.status, 202);
    assert.equal((await ok.json()).accepted, false);
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.deepEqual(health.stages, ['spaces', 'functions', 'vectordb', 'kb', 'agent', 'gateway', 'inference']);
  } finally {
    server.close();
  }
});

test('tool-event endpoint: with MCP_AUTH_TOKEN unset every request is refused', async () => {
  const recordingsDir = mkdtempSync(path.join(tmpdir(), 'anatomy-rec-'));
  const { app } = await createApp({ env: { PIPELINE_MODE: 'mock', MOCK_DELAY_SCALE: '0' }, recordingsDir, autoCapture: false });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await post(base, { phase: 'done', tool: 'search_facts' }, '')).status, 401);
    assert.equal((await post(base, { phase: 'done', tool: 'search_facts' }, 'anything')).status, 401);
  } finally {
    server.close();
  }
});

test('tool-event endpoint: real mode attributes events to the active question job (gateway + target stages)', async () => {
  const bus = new EventBus();
  const events = [];
  bus.on('event', (e) => events.push(e));
  const pipeline = new RealPipeline(bus, { MCP_AUTH_TOKEN: 'secret', HARNESS_API_TOKEN: 't' });
  const recordingsDir = mkdtempSync(path.join(tmpdir(), 'anatomy-rec-'));
  const { app } = await createApp({ env: { MCP_AUTH_TOKEN: 'secret' }, pipeline, recordingsDir, autoCapture: false });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    pipeline.activeRun = { jobId: 'job-1', ev: bus.forJob('job-1', 'query'), toolCalls: 0, toolDone: 0, toolErrors: 0, hits: [], seen: new Set() };
    const r1 = await (await post(base, { phase: 'start', callId: 'c1', tool: 'get_document', args: { key: 'facts/1.txt' }, target: 'spaces' }, 'secret')).json();
    assert.deepEqual(r1, { ok: true, accepted: true, jobId: 'job-1' });
    await post(base, { phase: 'done', callId: 'c1', tool: 'get_document', args: { key: 'facts/1.txt' }, target: 'spaces', ms: 33, summary: '44 chars', hits: [{ id: 'facts/1.txt', object_key: 'facts/1.txt', chunk: 'Acme…', score: null }] }, 'secret');
    await post(base, { phase: 'error', callId: 'c2', tool: 'search_facts', args: { query: 'q' }, target: 'pgvector', error: 'db down' }, 'secret');
    const stages = events.filter((e) => e.type === 'stage').map((e) => `${e.stage}:${e.status}`);
    assert.deepEqual(stages, ['gateway:start', 'spaces:start', 'spaces:done', 'gateway:done', 'vectordb:error', 'gateway:error']);
    assert.ok(events.every((e) => e.jobId === 'job-1' && e.flow === 'query'));
    const tools = events.filter((e) => e.type === 'tool');
    assert.deepEqual(tools.map((e) => e.data.phase), ['start', 'done', 'error']);
    assert.equal(tools[1].data.target, 'spaces');
    assert.equal(tools[2].data.error, 'db down');
    assert.match(events.find((e) => e.stage === 'gateway' && e.status === 'done').detail, /TOOL get_document\(key="facts\/1.txt"\) → spaces · 44 chars · 33 ms/);
    assert.equal(pipeline.activeRun.toolCalls, 1);
    assert.equal(pipeline.activeRun.toolDone, 1);
    assert.equal(pipeline.activeRun.toolErrors, 1);
    assert.deepEqual(pipeline.activeRun.hits.map((h) => h.id), ['facts/1.txt']);
  } finally {
    server.close();
  }
});

test('recorder: tool and gateway events are captured and replayed like any other event', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'anatomy-rec-'));
  const bus = new EventBus();
  const recorder = new Recorder(bus, { dir, autoCapture: true });
  const pipeline = new MockPipeline(bus, { delayScale: 0 });
  await pipeline.submitFact('pgvector powers the anatomy demo.');
  recorder.start('v4');
  const out = await pipeline.ask('What powers the demo?');
  assert.equal(out.backend, 'harness');
  assert.equal(out.timing.toolCalls, 1);
  const saved = await recorder.stop();
  const rec = await recorder.load('v4');
  assert.ok(saved.events > 8);
  assert.ok(rec.events.some((e) => e.type === 'tool' && e.data.phase === 'done'));
  assert.ok(rec.events.some((e) => e.type === 'stage' && e.stage === 'gateway' && e.status === 'done'));
  assert.ok(rec.events.some((e) => e.type === 'stage' && e.stage === 'vectordb' && e.data.op === 'tool'));
  const replayed = [];
  bus.on('event', (e) => e.replay && replayed.push(e));
  await recorder.replay('v4', { speed: 20 });
  assert.ok(replayed.some((e) => e.type === 'tool'));
  assert.ok(replayed.some((e) => e.stage === 'gateway'));
});
