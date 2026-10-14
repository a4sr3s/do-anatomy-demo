import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { EventBus } from '../server/bus.js';
import { RealPipeline, ANSWER_PRESETS, presetFor, presetName, answerConfig, answerOptions } from '../server/pipeline/real.js';
import { MockPipeline } from '../server/pipeline/mock.js';
import { createApp } from '../server/app.js';

/*
 * The UI mode toggle: POST /api/ask {mode: 'fast' | 'agent'} (public presets), the events each path emits
 * (what the scene animates from), the mock pipeline's two paths, and the agent-readiness endpoint.
 */
const FACT = 'The Ravenwood lighthouse is kept by Odalys Ferro, who has three cats.';
const ENV = { HARNESS_API_TOKEN: 'tok', HARNESS_INFERENCE_API_KEY: 'k', MCP_PUBLIC_URL: 'https://demo.example/mcp', MCP_AUTH_TOKEN: 'mcp-secret', HARNESS_CONFIG_ID: 'none', DATABASE_URL: 'postgres://stub' };
const starts = (events) => events.filter((e) => e.type === 'stage' && e.status === 'start').map((e) => e.stage);
const stagesOf = (events) => [...new Set(events.filter((e) => e.type === 'stage').map((e) => e.stage))];

/** Fake Serverless Inference transport for DirectInference (same shape as in search-first.test.js). */
function fakeInference(frames) {
  const calls = [];
  const request = (url, opts, cb) => {
    const req = new EventEmitter();
    req.reusedSocket = calls.length > 0;
    req.destroy = () => { req.destroyed = true; };
    req.end = (payload) => {
      calls.push({ url: String(url), body: JSON.parse(payload) });
      const res = Readable.from((async function* () { for (const f of frames) yield `data: ${JSON.stringify(f)}\n\n`; yield 'data: [DONE]\n\n'; })());
      res.statusCode = 200;
      res.setEncoding = () => {};
      setTimeout(() => cb(res), 0);
    };
    return req;
  };
  return { request, calls };
}
const delta = (d) => ({ id: 'c1', model: 'openai-gpt-oss-20b', choices: [{ index: 0, delta: d }] });
const GOOD = [delta({ reasoning_content: 'thinking' }), delta({ content: 'ANSWER:' }), delta({ content: ' Odalys Ferro keeps it' }), delta({ content: ' and has three cats.' })];

function setup(env = {}, { rows = [{ id: 7, chunk: FACT, score: 0.9, object_key: 'facts/1.txt' }] } = {}) {
  const bus = new EventBus();
  const events = [];
  bus.on('event', (e) => events.push(e));
  const p = new RealPipeline(bus, { ...ENV, ...env });
  p.count = rows.length;
  p.db = async () => ({ query: async () => ({ rows }) });
  const embedded = [];
  p.embed = async (texts) => { embedded.push(...texts); return texts.map(() => [0.5, 0.5, 0.5, 0.5]); };
  const inference = fakeInference(GOOD);
  p.direct.request = inference.request;
  p.mcpHealth = { ok: true, at: Date.now() };
  return { p, events, embedded, inference };
}

/** A scripted harness run that calls search_facts (reported by the MCP server) and answers. */
function agentHarness(p, { tool = true } = {}) {
  const prompts = [];
  p.harness.ask = async (prompt, hooks) => {
    prompts.push(prompt);
    hooks.onSession?.({ id: 's', name: 'sess', created: false, toolsMode: 'gateway', hash: 'h' });
    hooks.onStarted?.(120);
    if (tool) {
      p.handleToolEvent({ tool: 'search_facts', phase: 'start', args: { query: 'q', k: 3 }, target: 'pgvector', callId: 'c1' });
      p.handleToolEvent({ tool: 'search_facts', phase: 'done', args: { query: 'q', k: 3 }, target: 'pgvector', callId: 'c1', ms: 40, hits: [{ id: 7, chunk: FACT, score: 0.9 }], summary: '1 hit' });
    }
    hooks.onToken?.(' Odalys Ferro keeps it and has three cats.', 0);
    return { text: 'Odalys Ferro keeps it and has three cats.', tokens: 9, noMarker: false, reasoningTokens: 3, runId: 'r1', model: 'openai-gpt-oss-20b' };
  };
  return prompts;
}

test('presets: fast = search-first/direct/low, agent = tool; presetFor is case-insensitive and strict; answerOptions names the resolved path', () => {
  assert.deepEqual(ANSWER_PRESETS, { fast: { mode: 'search-first', backend: 'direct', effort: 'low' }, agent: { mode: 'tool' } });
  assert.deepEqual(presetFor('fast'), { mode: 'search-first', backend: 'direct', effort: 'low', preset: 'fast' });
  assert.deepEqual(presetFor(' Agent '), { mode: 'tool', preset: 'agent' });
  for (const bad of ['tool', 'search-first', '', undefined, null, 7, 'toString', 'constructor']) assert.equal(presetFor(bad), null, `${bad} is not a public preset`);
  assert.equal(presetName({ mode: 'tool' }), 'agent');
  assert.equal(presetName({ mode: 'search-first', backend: 'direct' }), 'fast');
  assert.equal(presetName({ mode: 'search-first', backend: 'harness' }), null);
  const cfg = answerConfig({});
  assert.deepEqual(answerOptions(cfg, presetFor('fast')), { mode: 'search-first', backend: 'direct', effort: 'low', preset: 'fast' });
  assert.deepEqual(answerOptions(cfg, presetFor('agent')), { mode: 'tool', backend: 'direct', effort: 'low', preset: 'agent' });
  assert.deepEqual(answerOptions(cfg, {}), { mode: 'search-first', backend: 'direct', effort: 'low', preset: 'fast' }, 'the server default is the fast preset');
  assert.deepEqual(answerOptions(answerConfig({ ANSWER_MODE: 'tool' }), {}), { mode: 'tool', backend: 'direct', effort: 'low', preset: 'agent' });
});

test('POST /api/ask: {mode: fast|agent} needs no secret, raw knobs still do, the preset wins over stray knobs, GET /api/ask/modes lists them', async () => {
  const asked = [];
  const pipeline = { mode: 'real', describe: () => ({ answerMode: 'search-first' }), ask: async (question, opts) => { asked.push(opts); return { answer: 'ok', sources: [], timing: {}, backend: 'x', answerMode: 'y', preset: opts.preset ?? null }; } };
  const { app } = await createApp({ env: { MCP_AUTH_TOKEN: 'secret', REPLAY_FALLBACK: 'false' }, pipeline, autoCapture: false });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = (body, headers = {}) => fetch(`${base}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then((r) => r.json());
    let r = await post({ question: 'q', mode: 'fast' });
    assert.deepEqual(asked.at(-1), { mode: 'search-first', backend: 'direct', effort: 'low', preset: 'fast' });
    assert.equal(r.preset, 'fast');
    r = await post({ question: 'q', mode: 'Agent' });
    assert.deepEqual(asked.at(-1), { mode: 'tool', preset: 'agent' });
    assert.equal(r.preset, 'agent');
    await post({ question: 'q' });
    assert.deepEqual(asked.at(-1), {}, 'no mode -> the configured path (server defaults unchanged)');
    await post({ question: 'q', mode: 'tool' });
    assert.deepEqual(asked.at(-1), {}, 'raw modes are not public');
    await post({ question: 'q', mode: 'search-first', backend: 'harness' });
    assert.deepEqual(asked.at(-1), {});
    await post({ question: 'q', mode: 'fast', backend: 'harness', effort: 'high' });
    assert.deepEqual(asked.at(-1), { mode: 'search-first', backend: 'direct', effort: 'low', preset: 'fast' }, 'a preset is never bent by extra knobs');
    await post({ question: 'q', mode: 'tool' }, { 'x-tool-event-token': 'secret' });
    assert.deepEqual(asked.at(-1), { mode: 'tool', backend: undefined, effort: undefined }, 'the secret still unlocks the raw knobs');
    const modes = await fetch(`${base}/api/ask/modes`).then((x) => x.json());
    assert.deepEqual(modes, { ok: true, modes: ANSWER_PRESETS, default: 'search-first' });
  } finally {
    server.close();
  }
});

test('fast preset on the real pipeline: App Platform events (kb/vectordb tagged search-first/direct) -> direct inference; no agent, no gateway, no tool events; job carries preset + timing', async () => {
  const { p, events, embedded, inference } = setup();
  p.harness.ask = async () => { throw new Error('harness must not be used'); };
  const out = await p.ask('Who keeps the Ravenwood lighthouse?', presetFor('fast'));
  assert.equal(out.answer, 'Odalys Ferro keeps it and has three cats.');
  assert.deepEqual({ preset: out.preset, mode: out.answerMode, backend: out.backend }, { preset: 'fast', mode: 'search-first', backend: 'direct' });
  assert.deepEqual(starts(events), ['kb', 'vectordb', 'inference']);
  assert.deepEqual(stagesOf(events).sort(), ['inference', 'kb', 'vectordb'], 'the Harness and the Gateway machines get nothing to light');
  assert.ok(!events.some((e) => e.type === 'tool'));
  const start = events.find((e) => e.type === 'job' && e.status === 'start');
  assert.deepEqual({ answerMode: start.data.answerMode, preset: start.data.preset, backend: start.data.backend, effort: start.data.effort }, { answerMode: 'search-first', preset: 'fast', backend: 'direct', effort: 'low' });
  for (const e of events.filter((e) => e.stage === 'kb' || (e.stage === 'vectordb'))) {
    assert.equal(e.data.mode, 'search-first', `${e.stage} ${e.status} is tagged for the scene`);
    assert.equal(e.data.backend, 'direct');
    assert.equal(e.data.via, 'app');
  }
  assert.equal(events.find((e) => e.stage === 'vectordb' && e.status === 'start').data.op, 'search');
  assert.equal(events.find((e) => e.stage === 'kb' && e.status === 'progress').data.step, 'embed');
  assert.equal(events.find((e) => e.stage === 'inference' && e.status === 'start').data.via, 'direct');
  const done = events.find((e) => e.type === 'job' && e.status === 'done');
  assert.equal(done.data.preset, 'fast');
  assert.equal(done.data.backend, 'direct');
  assert.ok(done.data.timing.firstTokenMs >= 0 && done.data.timing.totalMs >= done.data.timing.firstTokenMs);
  assert.equal(done.data.timing.toolCalls, 0);
  assert.deepEqual(embedded, ['Who keeps the Ravenwood lighthouse?']);
  assert.equal(inference.calls[0].body.reasoning_effort, 'low');
});

test('agent preset on the real pipeline: Harness -> gateway tool call -> pgvector -> inference; no app-side kb stage; job carries preset agent + tool calls', async () => {
  const { p, events, embedded, inference } = setup({ ANSWER_MODE: 'search-first' }); // configured fast, asked as agent
  const prompts = agentHarness(p);
  const out = await p.ask('Who keeps the Ravenwood lighthouse?', presetFor('agent'));
  assert.equal(out.answer, 'Odalys Ferro keeps it and has three cats.');
  assert.deepEqual({ preset: out.preset, mode: out.answerMode, backend: out.backend, toolCalls: out.timing.toolCalls }, { preset: 'agent', mode: 'tool', backend: 'harness', toolCalls: 1 });
  assert.deepEqual(starts(events), ['agent', 'inference', 'gateway', 'vectordb']);
  assert.ok(!events.some((e) => e.stage === 'kb'), 'the app never searches before the agent on this path');
  assert.deepEqual(embedded, []);
  assert.equal(inference.calls.length, 0, 'no direct inference call');
  assert.match(prompts[0], /search_facts/);
  const start = events.find((e) => e.type === 'job' && e.status === 'start');
  assert.deepEqual({ answerMode: start.data.answerMode, preset: start.data.preset, backend: start.data.backend }, { answerMode: 'tool', preset: 'agent', backend: 'harness' });
  const tool = events.filter((e) => e.type === 'tool').map((e) => e.data.phase);
  assert.deepEqual(tool, ['start', 'done']);
  assert.equal(events.find((e) => e.stage === 'gateway' && e.status === 'start').data.target, 'pgvector');
  assert.equal(events.find((e) => e.stage === 'vectordb' && e.status === 'start').data.op, 'tool');
  const done = events.find((e) => e.type === 'job' && e.status === 'done');
  assert.equal(done.data.preset, 'agent');
  assert.equal(done.data.timing.toolCalls, 1);
  assert.deepEqual(out.sources.map((s) => s.id), [7]);
});

test('context-in-prompt fallback inside the agent path tags its kb/vectordb events `context` (the harness dial animates, not the App Platform)', async () => {
  const { p, events } = setup({ HARNESS_TOOLS_MODE: 'none' });
  agentHarness(p, { tool: false });
  const out = await p.ask('Who keeps the Ravenwood lighthouse?', presetFor('agent'));
  assert.equal(out.answerMode, 'tool');
  assert.equal(out.fallback, 'context');
  const kb = events.filter((e) => e.stage === 'kb' || (e.stage === 'vectordb' && e.data.op === 'search'));
  assert.ok(kb.length >= 4);
  for (const e of kb) {
    assert.equal(e.data.mode, 'context');
    assert.equal(e.data.backend, undefined);
  }
  assert.equal(events.find((e) => e.type === 'job' && e.status === 'start').data.preset, 'agent');
});

test('mock pipeline: the fast preset emits the App Platform -> pgvector -> direct inference sequence; agent / default keep the harness + gateway sequence', async () => {
  const bus = new EventBus();
  const p = new MockPipeline(bus, { delayScale: 0 });
  const events = [];
  bus.on('event', (e) => events.push(e));
  await p.submitFact(FACT);
  events.length = 0;
  const fast = await p.ask('Who keeps the Ravenwood lighthouse?', presetFor('fast'));
  assert.ok(fast.answer.includes('Odalys'));
  assert.deepEqual({ preset: fast.preset, mode: fast.answerMode, backend: fast.backend, tc: fast.timing.toolCalls }, { preset: 'fast', mode: 'search-first', backend: 'direct', tc: 0 });
  assert.deepEqual(starts(events), ['kb', 'vectordb', 'inference']);
  assert.ok(!events.some((e) => e.stage === 'agent' || e.stage === 'gateway' || e.type === 'tool'));
  assert.equal(events.find((e) => e.stage === 'kb' && e.status === 'start').data.mode, 'search-first');
  assert.equal(events.find((e) => e.stage === 'kb' && e.status === 'start').data.backend, 'direct');
  assert.equal(events.find((e) => e.stage === 'vectordb' && e.status === 'start').data.op, 'search');
  assert.equal(events.find((e) => e.stage === 'inference' && e.status === 'start').data.via, 'direct');
  const start = events.find((e) => e.type === 'job' && e.status === 'start');
  assert.deepEqual({ a: start.data.answerMode, p: start.data.preset, b: start.data.backend }, { a: 'search-first', p: 'fast', b: 'direct' });
  const done = events.find((e) => e.type === 'job' && e.status === 'done');
  assert.equal(done.data.preset, 'fast');
  assert.ok(done.data.timing.firstTokenMs != null);
  assert.ok(events.some((e) => e.type === 'answer'));

  events.length = 0;
  const agent = await p.ask('Who keeps the Ravenwood lighthouse?', presetFor('agent'));
  assert.deepEqual({ preset: agent.preset, mode: agent.answerMode, backend: agent.backend, tc: agent.timing.toolCalls }, { preset: 'agent', mode: 'tool', backend: 'harness', tc: 1 });
  assert.deepEqual(starts(events), ['agent', 'gateway', 'vectordb', 'inference']);
  assert.ok(events.some((e) => e.type === 'tool' && e.data.phase === 'done'));
  assert.equal(events.find((e) => e.type === 'job' && e.status === 'start').data.preset, 'agent');

  events.length = 0;
  const dflt = await p.ask('Who keeps the Ravenwood lighthouse?');
  assert.equal(dflt.preset, 'agent', 'the mock default is unchanged (tool sequence)');
  assert.deepEqual(starts(events), ['agent', 'gateway', 'vectordb', 'inference']);
});

test('HTTP in mock mode: POST /api/ask {mode: fast} and {mode: agent} round-trip with preset + timing; /api/harness/warm answers 202', async () => {
  const { app } = await createApp({ env: { PIPELINE_MODE: 'mock', MOCK_DELAY_SCALE: '0', REPLAY_FALLBACK: 'false' }, autoCapture: false });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
    await post('/api/facts', { text: FACT });
    const fast = (await post('/api/ask', { question: 'Who keeps the lighthouse?', mode: 'fast' })).json;
    assert.equal(fast.preset, 'fast');
    assert.equal(fast.answerMode, 'search-first');
    assert.equal(fast.timing.toolCalls, 0);
    const agent = (await post('/api/ask', { question: 'Who keeps the lighthouse?', mode: 'agent' })).json;
    assert.equal(agent.preset, 'agent');
    assert.equal(agent.answerMode, 'tool');
    assert.equal(agent.timing.toolCalls, 1);
    const warm = await post('/api/harness/warm', {});
    assert.equal(warm.status, 202);
    assert.equal(warm.json.skipped, true);
  } finally {
    server.close();
  }
});

test('POST /api/harness/warm: thaws a PAUSED session (GET -> POST /resume -> GET), is throttled, runs no model call; without a token it is skipped', async () => {
  const { p } = setup();
  p.harness.sessionId = 'sess-1';
  p.harness.sessionName = 'alexis-anatomy-harness-v4b';
  const calls = [];
  let status = 'SESSION_STATUS_PAUSED';
  p.harness.fetch = async (url, init = {}) => {
    calls.push(`${init.method || 'GET'} ${String(url).replace(/^.*\/sessions/, '')}`);
    if (/\/resume$/.test(url)) { status = 'SESSION_STATUS_READY'; return new Response(null, { status: 204 }); }
    if (/\/sess-1$/.test(url)) return Response.json({ session: { session_id: 'sess-1', status } });
    throw new Error(`unexpected ${url}`);
  };
  const quiet = { log() {}, error() {} };
  const { app } = await createApp({ env: { MCP_AUTH_TOKEN: 'secret', REPLAY_FALLBACK: 'false' }, pipeline: p, autoCapture: false });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    p.warmAgent = p.warmAgent.bind(p);
    const first = await fetch(`${base}/api/harness/warm`, { method: 'POST' }).then((r) => r.json());
    assert.equal(first.ok, true);
    assert.equal(first.resumed, true);
    assert.equal(first.status, 'SESSION_STATUS_READY');
    assert.equal(first.session, 'alexis-anatomy-harness-v4b');
    assert.deepEqual(calls, ['GET /sess-1', 'POST /sess-1/resume', 'GET /sess-1']);
    const second = await fetch(`${base}/api/harness/warm`, { method: 'POST' }).then((r) => r.json());
    assert.equal(second.throttled, true, 'a second wake-up within the throttle window reuses the result');
    assert.equal(calls.length, 3, 'no further API calls');
    assert.equal(p.describe().harnessLastWarm.resumed, true);
    const ready = await new RealPipeline(new EventBus(), { ...ENV }).warmAgent(quiet).catch((e) => e);
    assert.ok(ready && typeof ready === 'object', 'never throws');
    const none = await new RealPipeline(new EventBus(), { HARNESS_INFERENCE_API_KEY: 'k' }).warmAgent(quiet);
    assert.deepEqual(none, { ok: false, skipped: true, reason: 'HARNESS_API_TOKEN not set' });
  } finally {
    server.close();
  }
});

test('agent path guard: "don\'t know" although search_facts returned hits -> one context run with those hits (fallback context-retry); no hits -> no retry', async () => {
  const { p, events } = setup();
  const prompts = [];
  const spanish = 'Todavía no lo sé.';
  p.harness.ask = async (prompt, hooks) => {
    prompts.push(prompt);
    hooks.onStarted?.(100);
    if (prompts.length === 1) {
      p.handleToolEvent({ tool: 'search_facts', phase: 'start', args: { query: 'faro', k: 3 }, target: 'pgvector', callId: 'c1' });
      p.handleToolEvent({ tool: 'search_facts', phase: 'done', args: { query: 'faro', k: 3 }, target: 'pgvector', callId: 'c1', ms: 30, hits: [{ id: 7, chunk: FACT, score: 0.8 }], summary: '1 hit' });
      hooks.onToken?.(spanish, 0);
      return { text: spanish, tokens: 3, noMarker: false, reasoningTokens: 0, runId: 'r1' };
    }
    hooks.onToken?.(' Odalys Ferro cuida el faro y tiene tres gatos.', 0);
    return { text: 'Odalys Ferro cuida el faro y tiene tres gatos.', tokens: 8, noMarker: false, reasoningTokens: 0, runId: 'r2' };
  };
  const out = await p.ask('¿Quién cuida el faro de Ravenwood?', presetFor('agent'));
  assert.equal(out.answer, 'Odalys Ferro cuida el faro y tiene tres gatos.');
  assert.equal(out.fallback, 'context-retry');
  assert.match(out.reason, /don't know despite 1 hit/);
  assert.equal(prompts.length, 2, 'exactly one more model run');
  assert.match(prompts[1], /Context:\n\[1\] The Ravenwood lighthouse is kept by Odalys Ferro/, 'the tool\'s hits go in the prompt');
  assert.ok(!events.some((e) => e.stage === 'kb'), 'no second search: the hits are reused');
  assert.equal(out.timing.toolCalls, 1);
  assert.deepEqual(out.sources.map((x) => x.id), [7]);
  const guard = events.find((e) => e.stage === 'agent' && e.status === 'progress' && e.data.fallback === 'context-retry');
  assert.equal(guard.data.hits, 1);
  assert.equal(events.find((e) => e.type === 'job' && e.status === 'done').data.fallback, 'context-retry');

  // unknown question: the tool returns nothing, the fixed line stands, no retry
  const { p: q } = setup({}, { rows: [] });
  const calls = [];
  q.harness.ask = async (prompt, hooks) => {
    calls.push(prompt);
    q.handleToolEvent({ tool: 'search_facts', phase: 'start', args: { query: 'z', k: 3 }, target: 'pgvector', callId: 'c2' });
    q.handleToolEvent({ tool: 'search_facts', phase: 'done', args: { query: 'z', k: 3 }, target: 'pgvector', callId: 'c2', ms: 20, hits: [], summary: 'NO_MATCHING_FACTS' });
    hooks.onToken?.('I do not know that yet.', 0);
    return { text: 'I do not know that yet.', tokens: 6, noMarker: false, reasoningTokens: 0, runId: 'r3' };
  };
  const unk = await q.ask('What is the orbital period of the planet Zorblax-9?', presetFor('agent'));
  assert.equal(unk.answer, 'I do not know that yet.');
  assert.equal(unk.fallback, null);
  assert.equal(calls.length, 1);
});
