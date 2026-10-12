import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { EventBus } from '../server/bus.js';
import { MockPipeline } from '../server/pipeline/mock.js';

const FACT = 'The DigitalOcean anatomy demo was first shown in Austin in October 2026.';

test('mock pipeline: submitting a fact then asking returns it, with stage events', async () => {
  const bus = new EventBus();
  const pipeline = new MockPipeline(bus, { delayScale: 0 });
  const events = [];
  bus.on('event', (e) => events.push(e));

  const ingest = await pipeline.submitFact(FACT);
  assert.equal(ingest.chunks, 1);
  assert.equal(pipeline.store.size, 1);

  const result = await pipeline.ask('Where was the anatomy demo first shown?');
  assert.ok(result.answer.includes(FACT), `answer should contain the fact, got: ${result.answer}`);
  assert.equal(result.sources.length, 1);

  const stages = events.filter((e) => e.type === 'stage' && e.status === 'start').map((e) => e.stage);
  // v4: the question goes to the Harness Runtime (agent), which searches pgvector through the Action Gateway (tool call)
  assert.deepEqual(stages, ['spaces', 'functions', 'vectordb', 'agent', 'gateway', 'vectordb', 'inference']);
  assert.ok(events.some((e) => e.type === 'tool' && e.data.tool === 'search_facts' && e.data.phase === 'done'));
  assert.equal(result.timing.toolCalls, 1);
  assert.equal(result.backend, 'harness');
  assert.ok(events.some((e) => e.type === 'stage' && e.stage === 'inference' && e.data?.token));
  assert.ok(events.some((e) => e.type === 'answer'));
});

test('mock pipeline: unknown question yields a graceful no-context answer', async () => {
  const pipeline = new MockPipeline(new EventBus(), { delayScale: 0 });
  const { answer, sources } = await pipeline.ask('What is the airspeed of an unladen swallow?');
  assert.equal(sources.length, 0);
  assert.match(answer, /couldn't find anything/i);
});

test('HTTP API: health, POST /api/facts, POST /api/ask round-trip over SSE', async () => {
  const recordingsDir = mkdtempSync(path.join(tmpdir(), 'anatomy-rec-'));
  const { app } = await createApp({ pipelineOverrides: { mode: 'mock', delayScale: 0 }, recordingsDir, autoCapture: false });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.mode, 'mock');

    // open SSE stream and collect raw text while jobs run
    const ac = new AbortController();
    const sse = await fetch(`${base}/api/events`, { signal: ac.signal });
    assert.match(sse.headers.get('content-type'), /text\/event-stream/);
    const reader = sse.body.getReader();
    let text = '';
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ done: true }));
        if (done) break;
        text += Buffer.from(value).toString();
      }
    })();

    const facts = await (await fetch(`${base}/api/facts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: FACT }) })).json();
    assert.equal(facts.ok, true);
    assert.equal(facts.chunks, 1);

    const ask = await (await fetch(`${base}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'When was the anatomy demo shown?' }) })).json();
    assert.equal(ask.ok, true);
    assert.ok(ask.answer.includes(FACT));

    const bad = await fetch(`${base}/api/facts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(bad.status, 400);

    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    await pump;
    assert.match(text, /event: hello/);
    assert.match(text, /"stage":"spaces","status":"start"/);
    assert.match(text, /event: answer/);
  } finally {
    server.close();
  }
});

test('mock pipeline: facts are listed and deleted (pgvector rows + Spaces object) with delete-flow events', async () => {
  const bus = new EventBus();
  const pipeline = new MockPipeline(bus, { delayScale: 0 });
  const events = [];
  bus.on('event', (e) => events.push(e));

  const a = await pipeline.submitFact(FACT);
  const b = await pipeline.submitFact('Acme Robotics renews its DigitalOcean contract every March.');
  const listed = await pipeline.listFacts();
  assert.equal(listed.length, 2);
  assert.equal(listed[0].key, b.key, 'newest first');
  assert.equal(listed[1].key, a.key);
  assert.equal(listed[1].text, FACT);
  assert.equal(listed[1].chunks, 1);
  assert.ok(listed[1].createdAt > 0);
  assert.equal(listed[1].id, a.key.replace(/^facts\//, '').replace(/\.txt$/, ''));
  assert.doesNotMatch(listed[1].id, /\//, 'id is URL-path safe');

  events.length = 0;
  const del = await pipeline.deleteFact(listed[1].id);
  assert.deepEqual({ id: del.id, key: del.key, removed: del.removed, total: del.total }, { id: listed[1].id, key: a.key, removed: 1, total: 1 });
  assert.equal(pipeline.store.size, 1);
  assert.equal((await pipeline.listFacts()).length, 1);
  assert.ok(events.every((e) => e.flow === 'delete'));
  const seq = events.filter((e) => e.type === 'stage').map((e) => `${e.stage}:${e.status}`);
  assert.deepEqual(seq, ['vectordb:start', 'vectordb:done', 'spaces:start', 'spaces:done'], 'rows go first, then the object');
  const vdone = events.find((e) => e.type === 'stage' && e.stage === 'vectordb' && e.status === 'done');
  assert.equal(vdone.data.op, 'delete');
  assert.deepEqual(vdone.data.ids, [1]);
  assert.equal(vdone.data.count, 1);
  const sdone = events.find((e) => e.type === 'stage' && e.stage === 'spaces' && e.status === 'done');
  assert.deepEqual(sdone.data, { op: 'delete', key: a.key });
  assert.equal(events.at(-1).type, 'job');
  assert.equal(events.at(-1).status, 'done');

  // the deleted fact no longer answers questions
  const { sources } = await pipeline.ask('Where was the anatomy demo first shown?');
  assert.equal(sources.length, 0);

  await assert.rejects(pipeline.deleteFact('nope'), (err) => err.status === 404);

  // the full key is accepted as an id too; clearing everything empties both stores in one job
  await pipeline.submitFact(FACT);
  events.length = 0;
  const all = await pipeline.deleteAllFacts();
  assert.equal(all.facts, 2);
  assert.equal(all.removed, 2);
  assert.equal(all.total, 0);
  assert.equal(pipeline.store.size, 0);
  assert.deepEqual(await pipeline.listFacts(), []);
  const jobs = events.filter((e) => e.type === 'job');
  assert.equal(jobs.length, 2, 'one job start + one done');
  assert.equal(jobs[0].data.all, true);
  const allDone = events.find((e) => e.type === 'stage' && e.stage === 'vectordb' && e.status === 'done');
  assert.equal(allDone.data.all, true);
  assert.equal(allDone.data.ids.length, 2);
  assert.equal(allDone.data.count, 0);
});

test('HTTP API: GET /api/facts, DELETE /api/facts/:id (404 when unknown), DELETE /api/facts', async () => {
  const recordingsDir = mkdtempSync(path.join(tmpdir(), 'anatomy-rec-'));
  const { app, bus } = await createApp({ pipelineOverrides: { mode: 'mock', delayScale: 0 }, recordingsDir, autoCapture: false });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const events = [];
  bus.on('event', (e) => events.push(e));
  const json = (method, p, body) => fetch(`${base}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    assert.deepEqual((await json('GET', '/api/facts')).body, { ok: true, mode: 'mock', facts: [], total: 0, chunks: 0 });
    await json('POST', '/api/facts', { text: FACT });
    await json('POST', '/api/facts', { text: 'Acme Robotics renews its DigitalOcean contract every March.' });
    const list = await json('GET', '/api/facts');
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 2);
    assert.equal(list.body.chunks, 2);
    assert.deepEqual(Object.keys(list.body.facts[0]).sort(), ['chunks', 'createdAt', 'id', 'key', 'text']);

    const missing = await json('DELETE', '/api/facts/does-not-exist');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.ok, false);

    const one = await json('DELETE', `/api/facts/${encodeURIComponent(list.body.facts[1].id)}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.removed, 1);
    assert.equal(one.body.total, 1);
    assert.equal((await json('GET', '/api/facts')).body.total, 1);
    assert.ok(events.some((e) => e.type === 'job' && e.flow === 'delete' && e.status === 'done'));

    const all = await json('DELETE', '/api/facts');
    assert.equal(all.status, 200);
    assert.equal(all.body.facts, 1);
    assert.equal(all.body.total, 0);
    assert.equal((await json('GET', '/api/facts')).body.total, 0);
    assert.equal((await json('GET', '/api/health')).body.pipeline.chunks, 0);
  } finally {
    server.close();
  }
});
