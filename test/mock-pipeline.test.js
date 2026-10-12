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
  assert.deepEqual(stages, ['spaces', 'functions', 'vectordb', 'kb', 'vectordb', 'agent', 'inference']);
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
