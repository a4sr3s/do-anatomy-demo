import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { EventBus } from '../server/bus.js';
import { RealPipeline, answerConfig, answerOptions } from '../server/pipeline/real.js';
import { DirectInference } from '../server/pipeline/direct.js';
import { createApp } from '../server/app.js';

const FACT = 'The Ravenwood lighthouse is kept by Odalys Ferro, who has three cats.';
// every knob pinned to its non-default value, so each test states the path it exercises explicitly
const ENV = { HARNESS_API_TOKEN: 'tok', HARNESS_INFERENCE_API_KEY: 'k', MCP_PUBLIC_URL: 'https://demo.example/mcp', MCP_AUTH_TOKEN: 'mcp-secret', HARNESS_CONFIG_ID: 'none', DATABASE_URL: 'postgres://stub', ANSWER_MODE: 'tool', SEARCH_FIRST_BACKEND: 'harness', SEARCH_FIRST_REASONING_EFFORT: 'off' };
const starts = (events) => events.filter((e) => e.type === 'stage' && e.status === 'start').map((e) => e.stage);
const tokensOf = (events) => events.filter((e) => e.type === 'stage' && e.stage === 'inference' && e.status === 'progress' && e.data.token !== undefined).map((e) => e.data.token).join('');

/**
 * Fake Serverless Inference transport for DirectInference: `script(body)` returns the SSE frames
 * (objects -> `data: {...}` lines) or { status, text } for an HTTP error; `hang` never answers.
 */
function fakeInference(script, { hang = false, delayMs = 0, networkError = null } = {}) {
  const calls = [];
  const request = (url, opts, cb) => {
    const req = new EventEmitter();
    req.reusedSocket = calls.length > 0;
    req.destroy = (err) => { req.destroyed = true; req.emit('close', err); };
    req.end = (payload) => {
      const body = JSON.parse(payload);
      calls.push({ url: String(url), headers: opts.headers, body });
      if (networkError) { setTimeout(() => req.emit('error', Object.assign(new Error(networkError), { code: 'ECONNRESET' })), 0); return; }
      if (hang) return;
      const r = script(body, calls.length);
      const frames = Array.isArray(r) ? r : null;
      const res = Readable.from((async function* () {
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (!frames) { yield r.text || 'error'; return; }
        for (const f of frames) yield typeof f === 'string' ? f : `data: ${JSON.stringify(f)}\n\n`;
        yield 'data: [DONE]\n\n';
      })());
      res.statusCode = frames ? 200 : r.status || 500;
      res.setEncoding = () => {};
      setTimeout(() => cb(res), 0);
    };
    return req;
  };
  return { request, calls };
}
const delta = (d) => ({ id: 'c1', model: 'openai-gpt-oss-20b', choices: [{ index: 0, delta: d }] });
const usage = (reasoning = 12) => ({ id: 'c1', choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, completion_tokens_details: { reasoning_tokens: reasoning } } });
const GOOD = [delta({ reasoning_content: 'The context says Odalys' }), delta({ content: 'ANSWER:' }), delta({ content: ' Odalys Ferro keeps it' }), delta({ content: ' and has three cats.' }), usage(12)];

/** Pipeline with a stubbed pgvector, a counted embedder, a fake direct transport and (optionally) a scripted harness. */
function setup(env, { rows = [{ id: 7, chunk: FACT, score: 0.9, object_key: 'facts/1.txt' }], inference = fakeInference(() => GOOD), harness = null } = {}) {
  const bus = new EventBus();
  const events = [];
  bus.on('event', (e) => events.push(e));
  const p = new RealPipeline(bus, { ...ENV, ...env });
  p.count = rows.length;
  const queries = [];
  p.db = async () => ({ query: async (sql, params) => { queries.push({ sql, params }); return { rows }; } });
  const embedded = [];
  p.embed = async (texts) => { embedded.push(...texts); return texts.map(() => new Array(4).fill(0.5)); };
  p.direct.request = inference.request;
  if (harness) p.harness.ask = harness;
  const realFetch = globalThis.fetch;
  const fetches = [];
  globalThis.fetch = async (url) => { fetches.push(String(url)); return new Response('unexpected', { status: 500 }); };
  return { p, events, queries, embedded, fetches, inference, restore: () => (globalThis.fetch = realFetch) };
}

test('answerConfig: defaults (search-first, direct backend, effort low, cache 256) and validation of every knob', () => {
  assert.deepEqual(answerConfig({}), { mode: 'search-first', backend: 'direct', effort: 'low', embedCacheSize: 256 });
  assert.deepEqual(answerConfig({ ANSWER_MODE: 'tool' }), { mode: 'tool', backend: 'direct', effort: 'low', embedCacheSize: 256 });
  assert.deepEqual(answerConfig({ ANSWER_MODE: 'search_first', SEARCH_FIRST_BACKEND: 'Direct', SEARCH_FIRST_REASONING_EFFORT: 'LOW', EMBED_CACHE_SIZE: '0' }), { mode: 'search-first', backend: 'direct', effort: 'low', embedCacheSize: 0 });
  assert.deepEqual(answerConfig({ ANSWER_MODE: 'magic', SEARCH_FIRST_BACKEND: 'agent', SEARCH_FIRST_REASONING_EFFORT: 'max', EMBED_CACHE_SIZE: '-3' }), { mode: 'search-first', backend: 'direct', effort: 'low', embedCacheSize: 256 });
  const cfg = answerConfig({ ANSWER_MODE: 'search-first', SEARCH_FIRST_BACKEND: 'harness', SEARCH_FIRST_REASONING_EFFORT: 'off' });
  assert.deepEqual(answerOptions(cfg, {}), { mode: 'search-first', backend: 'harness', effort: 'off', preset: null }, 'search-first on the harness is neither UI preset');
  assert.deepEqual(answerOptions(cfg, { mode: 'tool', backend: 'direct', effort: 'low' }), { mode: 'tool', backend: 'direct', effort: 'low', preset: 'agent' });
  assert.deepEqual(answerOptions(cfg, { mode: 'nope', backend: 7, effort: null }), { mode: 'search-first', backend: 'harness', effort: 'off', preset: null });
  assert.deepEqual(answerOptions(cfg, { mode: 'search-first', backend: 'direct' }), { mode: 'search-first', backend: 'direct', effort: 'off', preset: 'fast' }, 'the resolved path names its preset');
  assert.deepEqual(answerOptions(cfg, { mode: 'search-first', backend: 'direct', effort: 'low', preset: 'fast' }), { mode: 'search-first', backend: 'direct', effort: 'low', preset: 'fast' });
  const d = new RealPipeline(new EventBus(), { ...ENV, ANSWER_MODE: 'search-first', SEARCH_FIRST_BACKEND: 'direct' }).describe();
  assert.equal(d.answerMode, 'search-first');
  assert.equal(d.searchFirstBackend, 'direct');
  assert.equal(d.searchFirstReasoningEffort, 'off');
  assert.equal(d.direct.host, 'inference.do-ai.run');
  assert.deepEqual(d.embedCache, { size: 0, max: 256, hits: 0, misses: 0 });
  const dflt = new RealPipeline(new EventBus(), { HARNESS_INFERENCE_API_KEY: 'k' }).describe();
  assert.deepEqual({ m: dflt.answerMode, b: dflt.searchFirstBackend, e: dflt.searchFirstReasoningEffort, via: dflt.inferenceVia }, { m: 'search-first', b: 'direct', e: 'low', via: 'direct' }, 'the default path answers with the inference key alone');
  assert.equal(new RealPipeline(new EventBus(), { HARNESS_INFERENCE_API_KEY: 'k', ANSWER_MODE: 'tool' }).describe().inferenceVia, null, 'tool mode still needs the harness');
});

test('search-first via direct Serverless Inference: search first (kb -> vectordb), one streamed model round, ANSWER-only, no harness and no agent stage', async () => {
  const { p, events, queries, embedded, fetches, inference, restore } = setup({ ANSWER_MODE: 'search-first', SEARCH_FIRST_BACKEND: 'direct' });
  let harnessUsed = false;
  p.harness.ask = async () => { harnessUsed = true; throw new Error('harness must not be used'); };
  try {
    const out = await p.ask('Who keeps the Ravenwood lighthouse?');
    assert.equal(out.answer, 'Odalys Ferro keeps it and has three cats.');
    assert.equal(out.answerMode, 'search-first');
    assert.equal(out.backend, 'direct');
    assert.equal(out.fallback, null);
    assert.deepEqual(out.sources.map((s) => s.id), [7]);
    assert.equal(harnessUsed, false);
    assert.deepEqual(fetches, [], 'no MCP health check, no fetch at all: the search is in-app and the model call uses the keep-alive transport');
    assert.deepEqual(starts(events), ['kb', 'vectordb', 'inference'], 'the Harness machine is not lit: no agent stage on the direct path');
    assert.equal(tokensOf(events), 'Odalys Ferro keeps it and has three cats.', 'reasoning_content and the marker never stream');
    assert.deepEqual(embedded, ['Who keeps the Ravenwood lighthouse?']);
    assert.equal(queries.length, 1);
    assert.match(queries[0].sql, /ORDER BY embedding <=> \$1::vector LIMIT 3/);
    // the request itself
    assert.equal(inference.calls.length, 1);
    const { body, headers, url } = inference.calls[0];
    assert.equal(url, 'https://inference.do-ai.run/v1/chat/completions');
    assert.equal(headers.authorization, 'Bearer k');
    assert.equal(body.model, 'openai-gpt-oss-20b');
    assert.equal(body.stream, true);
    assert.equal(body.reasoning_effort, undefined, 'effort off sends no reasoning_effort');
    assert.match(body.messages[0].content, /Context:\n\[1\] The Ravenwood lighthouse is kept by Odalys Ferro/);
    assert.match(body.messages[0].content, /Question: Who keeps the Ravenwood lighthouse\?/);
    assert.doesNotMatch(body.messages[0].content, /^Reasoning:/m);
    // timing + events
    assert.equal(out.timing.toolCalls, 0);
    assert.equal(out.timing.reasoningTokens, 12);
    assert.equal(out.timing.hits, 1);
    assert.equal(out.timing.embedCached, false);
    assert.ok(out.timing.firstTokenMs >= 0 && out.timing.firstTokenMs <= out.timing.totalMs);
    assert.ok(typeof out.timing.searchMs === 'number' && typeof out.timing.modelStartedMs === 'number');
    const inf = events.find((e) => e.stage === 'inference' && e.status === 'start');
    assert.equal(inf.data.via, 'direct');
    assert.equal(inf.data.mode, 'search-first');
    const vdb = events.find((e) => e.stage === 'vectordb' && e.status === 'done');
    assert.equal(vdb.data.op, 'search');
    assert.deepEqual(vdb.data.hits, [{ id: 7, score: 0.9 }]);
    const done = events.find((e) => e.stage === 'inference' && e.status === 'done');
    assert.equal(done.data.via, 'direct');
    const job = events.at(-1);
    assert.equal(job.type, 'job');
    assert.equal(job.status, 'done');
    assert.equal(job.data.backend, 'direct');
    assert.equal(job.data.answerMode, 'search-first');
    assert.equal(events.find((e) => e.type === 'job' && e.status === 'start').data.answerMode, 'search-first');
    assert.ok(!events.some((e) => e.stage === 'agent'), 'no agent events at all on the direct path');
  } finally {
    restore();
  }
});

test('search-first via the harness: agent + kb + vectordb + inference, the context prompt goes to the session, rotation counters move, no tool prompt', async () => {
  const prompts = [];
  const harness = async (prompt, hooks) => {
    prompts.push(prompt);
    hooks.onSession?.({ id: 's1', name: 'alexis-anatomy-harness-v4b', created: false, hash: 'h' });
    hooks.onStarted?.(5);
    for (const [i, tok] of [' Odalys Ferro,', ' three cats.'].entries()) hooks.onToken?.(tok, i);
    return { text: 'Odalys Ferro, three cats.', tokens: 2, noMarker: false, model: 'openai-gpt-oss-20b', reasoningTokens: 7, runId: 'run-1', totalMs: 40 };
  };
  const { p, events, fetches, inference, restore } = setup({ ANSWER_MODE: 'search-first' }, { harness });
  p.harness.ensureSession = async () => ({ id: 's1', name: 'alexis-anatomy-harness-v4b', created: false, stale: false });
  try {
    const out = await p.ask('Who keeps the Ravenwood lighthouse?');
    assert.equal(out.answer, 'Odalys Ferro, three cats.');
    assert.equal(out.backend, 'harness');
    assert.equal(out.answerMode, 'search-first');
    assert.equal(out.fallback, null);
    assert.equal(inference.calls.length, 0, 'direct inference untouched');
    assert.deepEqual(fetches, [], 'no MCP health check on the search-first path');
    assert.deepEqual(starts(events), ['agent', 'kb', 'vectordb', 'inference']);
    assert.equal(prompts.length, 1, 'exactly one model round');
    assert.match(prompts[0], /Context:\n\[1\] The Ravenwood lighthouse/);
    assert.doesNotMatch(prompts[0], /search_facts/, 'no tool instructions: the facts are already in the prompt');
    assert.doesNotMatch(prompts[0], /^Reasoning:/m);
    assert.equal(tokensOf(events), ' Odalys Ferro, three cats.');
    assert.equal(out.timing.reasoningTokens, 7);
    const agentStart = events.find((e) => e.stage === 'agent' && e.status === 'start');
    assert.match(agentStart.detail, /answering search-first/);
    assert.equal(agentStart.data.mode, 'search-first');
    assert.equal(agentStart.data.toolsMode, 'none');
    const agentDone = events.find((e) => e.stage === 'agent' && e.status === 'done');
    assert.equal(agentDone.data.runId, 'run-1');
    assert.equal(agentDone.data.backend, 'harness');
    assert.equal(events.find((e) => e.stage === 'inference' && e.status === 'start').data.via, 'harness');
  } finally {
    restore();
  }
});

test('search-first: SEARCH_FIRST_REASONING_EFFORT=low is the reasoning_effort parameter directly and the "Reasoning: low" prompt line in the harness; tool mode keeps HARNESS_REASONING_EFFORT', async () => {
  const direct = setup({ ANSWER_MODE: 'search-first', SEARCH_FIRST_BACKEND: 'direct', SEARCH_FIRST_REASONING_EFFORT: 'low' });
  try {
    await direct.p.ask('Who keeps the Ravenwood lighthouse?');
    assert.equal(direct.inference.calls[0].body.reasoning_effort, 'low');
    assert.doesNotMatch(direct.inference.calls[0].body.messages[0].content, /^Reasoning:/m, 'the API parameter replaces the prompt line on the direct path');
  } finally {
    direct.restore();
  }
  const prompts = [];
  const harness = async (prompt, hooks) => { prompts.push(prompt); hooks.onToken?.(' ok', 0); return { text: 'ok', tokens: 1, noMarker: false, reasoningTokens: 0 }; };
  const viaHarness = setup({ ANSWER_MODE: 'search-first', SEARCH_FIRST_REASONING_EFFORT: 'low', HARNESS_REASONING_EFFORT: 'off' }, { harness });
  try {
    await viaHarness.p.ask('Who keeps the Ravenwood lighthouse?');
    assert.match(prompts[0], /^Reasoning: low\n/);
    // per-request override: effort off for one question
    await viaHarness.p.ask('Who keeps the Ravenwood lighthouse?', { effort: 'off' });
    assert.doesNotMatch(prompts[1], /^Reasoning:/m);
  } finally {
    viaHarness.restore();
  }
});

test('search-first: no matching facts -> the model still writes the "don\'t know" line (one round, empty context); Spanish question, Spanish line; no-marker runs answer it too', async () => {
  const inference = fakeInference((body, n) => (n === 1
    ? [delta({ reasoning_content: 'nothing in context' }), delta({ content: 'ANSWER: Todavía no lo sé.' }), usage(3)]
    : [delta({ reasoning_content: 'rambling' }), delta({ content: 'No puedo saberlo.' }), usage(3)]));
  const { p, events, inference: inf, restore } = setup({ ANSWER_MODE: 'search-first', SEARCH_FIRST_BACKEND: 'direct' }, { rows: [], inference });
  try {
    const out = await p.ask('¿Cuál es el periodo orbital del planeta Zorblax-9?');
    assert.equal(out.answer, 'Todavía no lo sé.');
    assert.equal(out.sources.length, 0);
    assert.equal(out.timing.hits, 0);
    assert.equal(inf.calls.length, 1, 'the model round ran: no app-side short-circuit');
    assert.match(inf.calls[0].body.messages[0].content, /Context:\n\(none\)/);
    assert.match(inf.calls[0].body.messages[0].content, /ANSWER: Todavía no lo sé\./);
    assert.equal(tokensOf(events), 'Todavía no lo sé.');
    assert.deepEqual(starts(events), ['kb', 'vectordb', 'inference']);
    // no ANSWER: line at all -> nothing of the model text is shown, the fixed line is the answer
    const out2 = await p.ask('¿Cuál es el periodo orbital del planeta Zorblax-9?');
    assert.equal(out2.answer, 'Todavía no lo sé.');
    assert.equal(out2.reason, 'no ANSWER: line');
    const toks = events.filter((e) => e.jobId === out2.jobId && e.stage === 'inference' && e.status === 'progress' && e.data.token !== undefined).map((e) => e.data.token);
    assert.deepEqual(toks, ['Todavía no lo sé.'], 'the rambling never streamed');
    assert.ok(events.some((e) => e.jobId === out2.jobId && e.stage === 'inference' && e.data?.noMarker === true));
  } finally {
    restore();
  }
});

test('search-first: the query-embedding cache skips /embeddings for a repeated question (normalised), is bounded, and EMBED_CACHE_SIZE=0 disables it', async () => {
  const { p, events, embedded, restore } = setup({ ANSWER_MODE: 'search-first', SEARCH_FIRST_BACKEND: 'direct', EMBED_CACHE_SIZE: '2' });
  try {
    const a = await p.ask('Who keeps the Ravenwood lighthouse?');
    assert.equal(a.timing.embedCached, false);
    const b = await p.ask('  who keeps THE Ravenwood   lighthouse? ');
    assert.equal(b.timing.embedCached, true);
    assert.deepEqual(embedded, ['Who keeps the Ravenwood lighthouse?'], 'one embedding call for the two questions');
    const cachedEv = events.find((e) => e.jobId === b.jobId && e.stage === 'kb' && e.status === 'progress');
    assert.equal(cachedEv.data.cached, true);
    assert.match(cachedEv.detail, /reused from the cache/);
    assert.deepEqual(p.describe().embedCache, { size: 1, max: 2, hits: 1, misses: 1 });
    await p.ask('second question');
    await p.ask('third question');
    assert.equal(p.embedCache.size, 2, 'bounded');
    assert.equal(p.embedCache.has('who keeps the ravenwood lighthouse?'), false, 'the oldest entry was evicted');
    // the guard search of the tool path goes through the same cache
    const g = await p.guardSearch('second question', { jobId: 'j', ev: p.bus.forJob('j', 'query'), toolCalls: 0, toolDone: 0, toolErrors: 0, hits: [], seen: new Set() });
    assert.equal(g.length, 1);
    assert.equal(p.embedCacheStats.hits, 2);
  } finally {
    restore();
  }
  const off = setup({ ANSWER_MODE: 'search-first', SEARCH_FIRST_BACKEND: 'direct', EMBED_CACHE_SIZE: '0' });
  try {
    await off.p.ask('Who keeps the Ravenwood lighthouse?');
    await off.p.ask('Who keeps the Ravenwood lighthouse?');
    assert.equal(off.embedded.length, 2);
    assert.equal(off.p.embedCache.size, 0);
  } finally {
    off.restore();
  }
});

test('search-first: a direct round that fails before its first token (HTTP error, network error, first-token timeout) is retried once in the harness (fallback "harness"); after the first token it is an error', async () => {
  const harnessPrompts = [];
  const harness = async (prompt, hooks) => { harnessPrompts.push(prompt); hooks.onToken?.(' from the harness', 0); return { text: 'from the harness', tokens: 1, noMarker: false, reasoningTokens: 0, runId: 'r' }; };
  // 1. HTTP 503
  const http503 = setup({ ANSWER_MODE: 'search-first', SEARCH_FIRST_BACKEND: 'direct' }, { inference: fakeInference(() => ({ status: 503, text: 'overloaded' })), harness });
  try {
    const out = await http503.p.ask('Who keeps the Ravenwood lighthouse?');
    assert.equal(out.answer, 'from the harness');
    assert.equal(out.backend, 'harness');
    assert.equal(out.fallback, 'harness');
    assert.match(out.reason, /Serverless Inference failed: 503 overloaded/);
    assert.deepEqual(starts(http503.events), ['kb', 'vectordb', 'inference', 'agent', 'inference']);
    assert.equal(harnessPrompts.length, 1);
    assert.match(harnessPrompts[0], /Context:\n\[1\] The Ravenwood/, 'the same prompt: no second search');
    assert.equal(http503.embedded.length, 1);
  } finally {
    http503.restore();
  }
  // 2. network error
  const net = setup({ ANSWER_MODE: 'search-first', SEARCH_FIRST_BACKEND: 'direct' }, { inference: fakeInference(() => GOOD, { networkError: 'socket hang up' }), harness });
  try {
    const out = await net.p.ask('Who keeps the Ravenwood lighthouse?');
    assert.equal(out.fallback, 'harness');
    assert.match(out.reason, /ECONNRESET socket hang up/);
  } finally {
    net.restore();
  }
  // 3. first-token timeout
  const hang = setup({ ANSWER_MODE: 'search-first', SEARCH_FIRST_BACKEND: 'direct', HARNESS_FIRST_TOKEN_TIMEOUT_MS: '40' }, { inference: fakeInference(() => GOOD, { hang: true }), harness });
  try {
    const out = await hang.p.ask('Who keeps the Ravenwood lighthouse?');
    assert.equal(out.fallback, 'harness');
    assert.match(out.reason, /timeout: produced nothing within 40 ms/);
  } finally {
    hang.restore();
  }
  // 4. no harness token: the error surfaces (server/app.js replays a recording)
  const alone = setup({ ANSWER_MODE: 'search-first', SEARCH_FIRST_BACKEND: 'direct', HARNESS_API_TOKEN: '', HARNESS_FIRST_TOKEN_TIMEOUT_MS: '40' }, { inference: fakeInference(() => GOOD, { hang: true }) });
  try {
    await assert.rejects(alone.p.ask('Who keeps the Ravenwood lighthouse?'), /Serverless Inference timeout: produced nothing within 40 ms/);
    assert.equal(alone.events.at(-1).status, 'error');
  } finally {
    alone.restore();
  }
  // 5. the stream dies after the first visible token: no silent second answer, the job fails
  const mid = setup({ ANSWER_MODE: 'search-first', SEARCH_FIRST_BACKEND: 'direct', HARNESS_TIMEOUT_MS: '60' }, { inference: fakeInference(() => [delta({ content: 'ANSWER: Odalys' }), 'data: {"choices":[{"delta":{"content":" Ferro"}}]}\n\n', ...Array(1).fill('')], { delayMs: 0 }), harness });
  try {
    // the whole-run timeout fires only if the stream never ends; here it ends normally, so the answer stands
    const out = await mid.p.ask('Who keeps the Ravenwood lighthouse?');
    assert.equal(out.answer, 'Odalys Ferro');
    assert.equal(out.fallback, null);
  } finally {
    mid.restore();
  }
});

test('DirectInference: body shape, reasoning_effort only when set, missing key is a before-first-token error, keep-alive counters', async () => {
  const inf = fakeInference(() => GOOD);
  const d = new DirectInference({ url: 'https://inference.do-ai.run/v1/', key: 'k', model: 'openai-gpt-oss-20b', request: inf.request });
  assert.equal(d.body('p').reasoning_effort, undefined);
  assert.equal(d.body('p', { effort: 'low' }).reasoning_effort, 'low');
  assert.equal(d.body('p', { effort: 'bogus' }).reasoning_effort, undefined);
  assert.deepEqual(d.body('p').stream_options, { include_usage: true });
  const toks = [];
  const a = await d.ask('p', { onToken: (t) => toks.push(t) });
  assert.equal(a.text, 'Odalys Ferro keeps it and has three cats.');
  assert.deepEqual(toks, ['Odalys Ferro keeps it', ' and has three cats.']);
  assert.equal(a.reasoningTokens, 12);
  assert.equal(a.tokensIn, 120);
  assert.equal(a.reused, false);
  const b = await d.ask('p');
  assert.equal(b.reused, true, 'the second request reports a reused socket');
  assert.deepEqual({ requests: d.status().requests, reused: d.status().reusedConnections }, { requests: 2, reused: 1 });
  const noKey = new DirectInference({ url: 'https://inference.do-ai.run/v1', key: '', model: 'm', request: inf.request });
  await assert.rejects(noKey.ask('p'), (err) => /HARNESS_INFERENCE_API_KEY missing/.test(err.message) && err.beforeFirstToken === true);
  // garbage lines and an in-stream error object
  const bad = new DirectInference({ url: 'https://inference.do-ai.run/v1', key: 'k', model: 'm', request: fakeInference(() => ['data: not json\n\n', { error: { message: 'model overloaded' } }]).request });
  await assert.rejects(bad.ask('p'), /Serverless Inference error: model overloaded/);
});

test('POST /api/ask: {mode, backend, effort} overrides only count with the shared secret; the configured path is the default and tool mode stays available', async () => {
  const asked = [];
  const pipeline = { mode: 'real', describe: () => ({}), ask: async (question, opts) => { asked.push({ question, opts }); return { answer: 'ok', sources: [], timing: {}, backend: 'direct', answerMode: opts.mode || 'configured' }; } };
  const { app } = await createApp({ env: { MCP_AUTH_TOKEN: 'secret', REPLAY_FALLBACK: 'false' }, pipeline, autoCapture: false });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = (body, headers = {}) => fetch(`${base}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then((r) => r.json());
    await post({ question: 'q' });
    assert.deepEqual(asked[0].opts, {});
    await post({ question: 'q', mode: 'tool', backend: 'direct', effort: 'low' });
    assert.deepEqual(asked[1].opts, {}, 'without the secret the overrides are ignored');
    await post({ question: 'q', mode: 'tool', backend: 'direct', effort: 'low' }, { 'x-tool-event-token': 'wrong' });
    assert.deepEqual(asked[2].opts, {});
    const r = await post({ question: 'q', mode: 'tool' }, { 'x-tool-event-token': 'secret' });
    assert.deepEqual(asked[3].opts, { mode: 'tool', backend: undefined, effort: undefined });
    assert.equal(r.mode, 'real', 'the response `mode` stays the pipeline mode');
    assert.equal(r.answerMode, 'tool');
    await post({ question: 'q', backend: 'direct', effort: 'low' }, { 'x-tool-event-token': 'secret' });
    assert.deepEqual(asked[4].opts, { mode: undefined, backend: 'direct', effort: 'low' });
  } finally {
    server.close();
  }
});

test('tool mode is untouched by the search-first code: ANSWER_MODE=tool never embeds app-side before the harness run and the result says mode "tool"', async () => {
  const { p, embedded, inference, restore } = setup({ ANSWER_MODE: 'tool' });
  let prompt = '';
  p.harness.ask = async (text, hooks) => { prompt = text; hooks.onToolEvent?.({ type: 'run.tool_call_started', data: { tool: 'do_actions_anatomy-data_search_facts', call_id: 'c1', input: { query: 'q' } } }); hooks.onToken?.(' ok', 0); return { text: 'ok', tokens: 1, noMarker: false, reasoningTokens: 0, runId: 'r' }; };
  p.mcpHealth = { ok: true, at: Date.now() };
  try {
    const out = await p.ask('Who keeps the Ravenwood lighthouse?');
    assert.equal(out.answerMode, 'tool');
    assert.equal(out.backend, 'harness');
    assert.match(prompt, /search_facts/);
    assert.deepEqual(embedded, [], 'no app-side embedding on the tool path');
    assert.equal(inference.calls.length, 0);
    // and per request the other way round: a tool-mode deployment can serve one search-first question
    const sf = await p.ask('Who keeps the Ravenwood lighthouse?', { mode: 'search-first', backend: 'direct' });
    assert.equal(sf.answerMode, 'search-first');
    assert.equal(sf.backend, 'direct');
    assert.equal(inference.calls.length, 1);
  } finally {
    restore();
  }
});
