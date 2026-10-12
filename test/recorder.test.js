import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventBus } from '../server/bus.js';
import { Recorder } from '../server/recorder.js';
import { MockPipeline } from '../server/pipeline/mock.js';
import { createApp } from '../server/app.js';

test('recorder: records a job and replays it with replay flag', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'anatomy-rec-'));
  const bus = new EventBus();
  const recorder = new Recorder(bus, { dir, autoCapture: true });
  const pipeline = new MockPipeline(bus, { delayScale: 0 });

  recorder.start('demo');
  await pipeline.submitFact('Replay test fact about pgvector.');
  const saved = await recorder.stop();
  assert.ok(saved.events > 5);
  assert.ok((await recorder.list()).some((r) => r.name === 'demo'));
  assert.ok((await recorder.list()).some((r) => r.name === 'auto-ingest'), 'auto capture stores latest ingest');

  const replayed = [];
  bus.on('event', (e) => e.replay && replayed.push(e));
  await recorder.replay('demo', { speed: 20 });
  assert.ok(replayed.some((e) => e.type === 'stage' && e.stage === 'vectordb' && e.status === 'done'));
  assert.ok(replayed.every((e) => e.replay === true));
});

test('server falls back to a replay when the real stage fails with a network error', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'anatomy-rec-'));
  const bus = new EventBus();
  // Seed a "latest good" ingest recording using the mock pipeline, then swap in a failing pipeline.
  const seedRecorder = new Recorder(bus, { dir, autoCapture: true });
  await new MockPipeline(bus, { delayScale: 0 }).submitFact('seed fact');
  await new Promise((r) => setTimeout(r, 20)); // let auto-save flush
  seedRecorder.autoCapture = false;

  const failing = {
    mode: 'real',
    describe: () => ({ mode: 'real' }),
    submitFact: async () => {
      throw Object.assign(new Error('fetch failed: ECONNREFUSED'), { code: 'ECONNREFUSED' });
    },
    ask: async () => {
      throw new Error('fetch failed');
    },
  };
  const { app } = await createApp({ pipeline: failing, recordingsDir: dir, autoCapture: false });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await (await fetch(`${base}/api/facts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x' }) })).json();
    assert.equal(res.ok, true);
    assert.equal(res.fallback, true);
    assert.equal(res.recording, 'auto-ingest');
  } finally {
    server.close();
  }
});
