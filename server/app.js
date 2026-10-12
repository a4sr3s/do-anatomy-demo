import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventBus } from './bus.js';
import { Recorder } from './recorder.js';
import { createPipeline } from './pipeline/index.js';
import { tokenEquals } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// v4: `agent` is the Harness Runtime, `gateway` the Action Gateway / MCP hop it uses to reach vectordb + spaces
const STAGE_ORDER = ['spaces', 'functions', 'vectordb', 'kb', 'agent', 'gateway', 'inference'];
const isNetworkError = (err) =>
  /ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed|timeout|network|5\d\d|credentials missing|DATABASE_URL missing|_KEY missing/i.test(
    `${err?.code || ''} ${err?.message || ''}`
  );

/**
 * Create the Express app plus its bus/pipeline/recorder. Exported so tests can
 * spin up an instance with instant mock timing.
 */
export async function createApp(options = {}) {
  const env = options.env || process.env;
  const bus = new EventBus();
  const pipeline = options.pipeline || (await createPipeline(bus, env, options.pipelineOverrides || {}));
  const recorder = new Recorder(bus, {
    dir: options.recordingsDir || env.RECORDINGS_DIR || path.join(ROOT, 'recordings'),
    autoCapture: options.autoCapture ?? true,
  });
  const replayFallback = (options.replayFallback ?? env.REPLAY_FALLBACK ?? 'true') !== 'false' && options.replayFallback !== false;
  const startedAt = Date.now();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  // ---- health -------------------------------------------------------------
  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      mode: pipeline.mode,
      uptime: Math.round((Date.now() - startedAt) / 1000),
      pipeline: pipeline.describe(),
      recorder: recorder.status,
      replayFallback,
      stages: STAGE_ORDER,
    });
  });

  // ---- SSE ----------------------------------------------------------------
  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 2000\n\n');
    const send = (e) => res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    send({ id: 0, type: 'hello', ts: Date.now(), data: { mode: pipeline.mode, pipeline: pipeline.describe(), recorder: recorder.status } });
    // Let late joiners catch up on recent events (e.g. page reload mid-demo)
    const since = Number(req.get('Last-Event-ID') || req.query.since || 0);
    bus.history.filter((e) => e.id > since).slice(-50).forEach(send);
    bus.on('event', send);
    const beat = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(beat);
      bus.off('event', send);
    });
  });

  // ---- pipeline actions ---------------------------------------------------
  async function runWithFallback(flow, fn, res) {
    try {
      const result = await fn();
      res.json({ ok: true, mode: pipeline.mode, ...result });
    } catch (err) {
      console.error(`[${flow}] failed:`, err.message);
      const rec = replayFallback && isNetworkError(err) ? await recorder.fallbackFor(flow) : null;
      if (rec && !recorder.replaying) {
        bus.publish({ type: 'fallback', flow, data: { reason: err.message, recording: rec.name } });
        const out = await recorder.replay(rec, { speed: 1, reason: 'fallback' });
        return res.json({ ok: true, mode: 'replay', fallback: true, reason: err.message, recording: rec.name, ...(out.answer ? { answer: out.answer.text, sources: out.answer.sources } : {}) });
      }
      res.status(502).json({ ok: false, error: err.message, jobId: err.jobId });
    }
  }

  app.post('/api/facts', (req, res) => {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ ok: false, error: 'text is required' });
    if (text.length > 4000) return res.status(400).json({ ok: false, error: 'text too long (max 4000 chars)' });
    return runWithFallback('ingest', () => pipeline.submitFact(text), res);
  });

  // ---- facts: list / delete (pgvector rows + Spaces object) ----------------
  // Deletions never fall back to a replay: the caller must know whether data is gone.
  const factsRoute = (fn) => async (req, res) => {
    try {
      res.json({ ok: true, mode: pipeline.mode, ...(await fn(req)) });
    } catch (err) {
      if (!err.status) console.error('[facts] failed:', err.message);
      res.status(err.status || (isNetworkError(err) ? 502 : 500)).json({ ok: false, error: err.message, jobId: err.jobId });
    }
  };
  app.get('/api/facts', factsRoute(async () => {
    const facts = await pipeline.listFacts();
    return { facts, total: facts.length, chunks: facts.reduce((n, f) => n + (f.chunks || 0), 0) };
  }));
  app.delete('/api/facts', factsRoute(() => pipeline.deleteAllFacts()));
  app.delete('/api/facts/:id', factsRoute((req) => pipeline.deleteFact(req.params.id)));

  app.post('/api/ask', (req, res) => {
    const question = String(req.body?.question || '').trim();
    if (!question) return res.status(400).json({ ok: false, error: 'question is required' });
    return runWithFallback('query', () => pipeline.ask(question), res);
  });

  // ---- internal: tool calls reported by the MCP server ----------------------
  // The mcp/ service POSTs here (TOOL_EVENT_URL) for every tool call; the event
  // is attributed to the question job currently running in the harness.
  const toolEventToken = env.MCP_AUTH_TOKEN || '';
  app.post('/api/internal/tool-event', (req, res) => {
    if (!tokenEquals(req.get('x-tool-event-token'), toolEventToken)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (typeof pipeline.handleToolEvent !== 'function') return res.status(202).json({ ok: true, accepted: false, reason: `no tool events in ${pipeline.mode} mode` });
    const out = pipeline.handleToolEvent(req.body || {});
    res.json({ ok: true, ...out });
  });

  // ---- recording / replay -------------------------------------------------
  const wrap = (fn) => async (req, res) => {
    try {
      res.json({ ok: true, ...(await fn(req)) });
    } catch (err) {
      res.status(err.status || 400).json({ ok: false, error: err.message });
    }
  };
  app.get('/api/recordings', wrap(async () => ({ recordings: await recorder.list(), ...recorder.status })));
  app.post('/api/recordings/start', wrap(async (req) => recorder.start(req.body?.name)));
  app.post('/api/recordings/stop', wrap(() => recorder.stop()));
  app.post('/api/replay/stop', wrap(async () => ({ stopped: recorder.stopReplay() })));
  app.get('/api/recordings/:name', wrap(async (req) => ({ recording: await recorder.load(req.params.name) })));
  app.delete('/api/recordings/:name', wrap(async (req) => ({ removed: await recorder.remove(req.params.name).then(() => true) })));
  app.post('/api/recordings/:name/replay', async (req, res) => {
    try {
      const rec = await recorder.load(req.params.name);
      const speed = req.body?.speed ?? 1;
      if (req.body?.wait) return res.json({ ok: true, ...(await recorder.replay(rec, { speed })) });
      recorder.replay(rec, { speed }).catch((e) => console.error('replay failed', e.message));
      res.json({ ok: true, name: rec.name, events: rec.events.length, speed });
    } catch (err) {
      res.status(err.code === 'ENOENT' ? 404 : 400).json({ ok: false, error: err.code === 'ENOENT' ? 'recording not found' : err.message });
    }
  });

  // ---- static frontend (production) --------------------------------------
  const dist = path.join(ROOT, 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { maxAge: '1h', index: 'index.html' }));
    app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
  } else {
    app.get('/', (req, res) => res.type('text').send('Frontend not built. Run `npm run build` or use `npm run dev`.\n'));
  }
  app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'not found' }));

  return { app, bus, pipeline, recorder };
}
