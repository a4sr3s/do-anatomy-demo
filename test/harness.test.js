import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../server/bus.js';
import { RealPipeline } from '../server/pipeline/real.js';
import { MarkerFilter, HarnessClient, buildManifest, buildPrompt, buildToolPrompt, harnessConfig, manifestHash, isDontKnow, normalizeToolName, toolTarget, reasoningLine, rotatedName, isSessionOf, DEFAULT_CONFIG_ID, DONT_KNOW_TEXT } from '../server/pipeline/harness.js';
import { createApp } from '../server/app.js';

const FACT = 'Acme Robotics runs 40 GPU droplets in SFO3.';
const sseFrame = (e) => `id: x\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
// HARNESS_CONFIG_ID=none: the manifest (YAML) path these tests were written for; the config path has its own tests below
const BASE_ENV = { HARNESS_API_TOKEN: 'tok', HARNESS_INFERENCE_API_KEY: 'k', MCP_PUBLIC_URL: 'https://demo.example/mcp', MCP_AUTH_TOKEN: 'mcp-secret', HARNESS_CONFIG_ID: 'none' };
const CONFIG_ID = '01a132ee-ff11-7130-9d05-838874ecec77';
/** Config path env: sessions come from the Environment Config, rotation polls fast and never backs off for long. */
const CONFIG_ENV = { ...BASE_ENV, HARNESS_CONFIG_ID: CONFIG_ID, HARNESS_ROTATE_POLL_MS: '1', HARNESS_ROTATE_READY_TIMEOUT_MS: '2000' };
const quiet = { log() {}, error() {}, debug() {} };

/**
 * Fake Harness Runtime API: list -> sessions (with labels), create -> new
 * session, events -> scripted stream, input -> run id. `onInput` lets a test
 * react to the prompt (e.g. simulate the MCP server reporting tool events).
 */
function fakeHarness(deltas, { fail = false, sessions, extraEvents = [], onInput, hang = false, name = 'alexis-anatomy-harness-v4b', perPage = 100, createdStatus = 'SESSION_STATUS_READY', usage = null } = {}) {
  const calls = [];
  const runId = 'run-1';
  const state = { sessions: sessions || [{ session_id: 'sess-1', name, status: 'SESSION_STATUS_PAUSED', labels: { manifest: '__match__' } }], nextId: 0, createdStatus };
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body, headers: init.headers });
    const u = String(url);
    if (u.includes('?name=')) {
      const want = decodeURIComponent(u.split('?name=')[1]);
      return Response.json({ sessions: state.sessions.filter((s) => s.name === want) });
    }
    if (u.includes('?per_page=')) {
      // paged listing like the live API (the fake's own page size, so a small `perPage` forces paging via meta.total)
      const q = new URL(u).searchParams;
      const size = Math.min(perPage, Number(q.get('per_page')) || perPage);
      const page = Number(q.get('page')) || 1;
      const live = state.sessions;
      return Response.json({ sessions: live.slice((page - 1) * size, page * size), meta: { total: live.length } });
    }
    if (init.method === 'POST' && u.endsWith('/sessions')) {
      const json = init.headers?.['content-type'] === 'application/json' ? JSON.parse(init.body) : null;
      const created = {
        session_id: `sess-${state.sessions.length + 1 + state.nextId++}`,
        name: json ? json.name : /^name: (.*)$/m.exec(init.body)[1],
        status: json ? state.createdStatus : 'SESSION_STATUS_RUNNING',
        created_at: new Date().toISOString(),
        ...(json ? { config_id: json.config_id } : {}),
      };
      state.sessions.push(created);
      return Response.json({ session: created });
    }
    if (init.method === 'DELETE') {
      const id = u.split('/').pop();
      const s = state.sessions.find((x) => x.session_id === id);
      if (!s) return new Response('not found', { status: 404 });
      s.status = 'SESSION_STATUS_DESTROYED';
      return new Response(null, { status: 204 });
    }
    if (!init.method && /\/sessions\/[^/?]+$/.test(u)) {
      const s = state.sessions.find((x) => x.session_id === u.split('/').pop());
      return s ? Response.json({ session: s }) : new Response('not found', { status: 404 });
    }
    if (u.endsWith('/input')) {
      const text = JSON.parse(init.body).text;
      if (onInput?.(text, u) === false) return new Response('gone', { status: 404 });
      return Response.json({ run_id: runId });
    }
    if (u.endsWith('/events')) {
      if (hang) {
        // an open stream that only ends when the caller aborts (like a real fetch body)
        const body = new ReadableStream({ start(ctrl) { init.signal?.addEventListener('abort', () => ctrl.error(init.signal.reason)); } });
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      const evs = [
        { type: 'run.log', run_id: 'old', data: { message: 'history' } },
        { type: 'run.token_delta', run_id: 'old', data: { text: 'ANSWER: stale', is_reasoning: false } },
        { type: 'run.started', run_id: runId, data: {} },
        ...extraEvents.map((e) => ({ ...e, run_id: runId })),
        ...deltas.map((t) => ({ type: 'run.token_delta', run_id: runId, data: { text: t, is_reasoning: false } })),
        { type: 'run.token_delta', run_id: runId, data: { text: 'hidden', is_reasoning: true } },
        { type: 'run.usage_recorded', run_id: runId, data: { model_id: 'openai-gpt-oss-20b', ...(usage ? { usage } : {}) } },
        fail ? { type: 'run.failed', run_id: runId, data: { message: 'boom' } } : { type: 'run.completed', run_id: runId, data: { total_tokens_in: 10, total_tokens_out: 3 } },
      ];
      return new Response(evs.map(sseFrame).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('nope', { status: 500 });
  };
  return { impl, calls, state };
}

/** Pipeline with a stubbed pgvector, a fake harness and a routed global fetch (MCP health only). */
function setup(env, harness, { mcpHealthy = true } = {}) {
  const bus = new EventBus();
  const events = [];
  bus.on('event', (e) => events.push(e));
  const p = new RealPipeline(bus, { DATABASE_URL: 'postgres://stub', ...env });
  p.count = 1;
  p.db = async () => ({ query: async () => ({ rows: [{ id: 7, chunk: FACT, score: 0.9, object_key: 'facts/1.txt' }] }) });
  if (harness) {
    // the fake session list uses a placeholder label that matches whatever the current manifest hashes to
    for (const s of harness.state.sessions) if (s.labels?.manifest === '__match__') s.labels.manifest = manifestHash(p.cfg.harness);
    p.harness.fetch = harness.impl;
  }
  const fetches = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    fetches.push({ url: String(url), init });
    if (String(url).endsWith('/mcp/health')) return mcpHealthy ? Response.json({ ok: true }) : new Response('down', { status: 503 });
    return new Response('unexpected', { status: 500 });
  };
  return { p, events, fetches, restore: () => (globalThis.fetch = realFetch) };
}

const starts = (events) => events.filter((e) => e.type === 'stage' && e.status === 'start').map((e) => e.stage);
const tokensOf = (events) => events.filter((e) => e.type === 'stage' && e.stage === 'inference' && e.status === 'progress').map((e) => e.data.token).join('');

test('harness: MarkerFilter hides text before ANSWER: and never falls back to pre-marker text', () => {
  const out = [];
  const f = new MarkerFilter((t) => out.push(t));
  ['We need to', ' answer. ANS', 'WER:', ' 40', ' droplets.'].forEach((t) => f.push(t));
  assert.equal(out.join(''), '40 droplets.');
  assert.deepEqual(f.finish(), { text: '40 droplets.', tokens: 2, noMarker: false });
  // no marker at all: reasoning is never emitted and never returned
  const n = [];
  const g = new MarkerFilter((t) => n.push(t));
  ['We should search again. ', 'The user asks about droplets; ', 'I will reply that I do not know.'].forEach((t) => g.push(t));
  assert.deepEqual(g.finish(), { text: '', tokens: 0, noMarker: true });
  assert.deepEqual(n, []);
  const e = new MarkerFilter((t) => n.push(t));
  assert.deepEqual(e.finish(), { text: '', tokens: 0, noMarker: true });
  assert.deepEqual(n, []);
});

test('harness: MarkerFilter strips trailing Harmony/channel junk from streamed tokens and from the answer', () => {
  const cases = [
    ['ANSWER: Acme runs 40 GPU droplets.<|end|><|start|>assistant<|channel|>analysis<|message|>We should check.', 'Acme runs 40 GPU droplets.'],
    ['ANSWER: Acme runs 40 GPU droplets.<|return|>', 'Acme runs 40 GPU droplets.'],
    ['ANSWER: Acme runs 40 GPU droplets.assistantfinalANSWER: Acme runs 40 GPU droplets.', 'Acme runs 40 GPU droplets.'],
    ['ANSWER: Acme runs 40 GPU droplets. analysisWe must verify.', 'Acme runs 40 GPU droplets.'],
    ['ANSWER: I do not know that yet.<|channel|>final<|message|>', 'I do not know that yet.'],
    ['<|channel|>final<|message|>ANSWER: 40 droplets.<|end|>', '40 droplets.'],
  ];
  for (const [input, want] of cases) {
    const out = [];
    const f = new MarkerFilter((t) => out.push(t));
    // stream in small deltas so control tokens are split across pushes
    for (let i = 0; i < input.length; i += 4) f.push(input.slice(i, i + 4));
    assert.equal(out.join(''), want, `stream: ${input}`);
    assert.equal(f.finish().text, want, `finish: ${input}`);
    assert.ok(out.every((t) => !/<\||assistant|analysis/.test(t)), `no junk token leaks: ${input}`);
  }
  // the same text in one push
  const g = new MarkerFilter(() => {});
  g.push('ANSWER: 40 droplets.<|end|><|start|>assistant<|channel|>analysis<|message|>hmm');
  assert.equal(g.finish().text, '40 droplets.');
  // a real sentence containing "analysis" as a word is kept
  const k = new MarkerFilter(() => {});
  k.push('ANSWER: The analysis runs nightly on 3 droplets.');
  assert.equal(k.finish().text, 'The analysis runs nightly on 3 droplets.');
});

test('harness: MarkerFilter streams only the first answer line; thinking after it never streams, the last ANSWER: wins', () => {
  // live gpt-oss output: a first ANSWER line, then plain-text thinking glued on, another search, a second ANSWER line
  const out = [];
  const f = new MarkerFilter((t) => out.push(t));
  ['ANSWER: I do not', ' know that yet.', 'We must keep repeating? ', 'Maybe search again.', 'No hits. Then answer not known.', 'ANSWER: I do not know that yet.'].forEach((t) => f.push(t));
  assert.equal(out.join(''), 'I do not know that yet.');
  assert.equal(f.finish().text, 'I do not know that yet.');
  // a newline ends the answer line too; a tool call (close) stops streaming; the final text is the last segment
  const n = [];
  const g = new MarkerFilter((t) => n.push(t));
  g.push('ANSWER: Odalys Ferro keeps it.\nLet me double-check with get_document.');
  assert.equal(n.join(''), 'Odalys Ferro keeps it.');
  const h = new MarkerFilter((t) => n.push(t));
  n.length = 0;
  h.push('ANSWER: Not sure');
  h.close();
  h.push(' yet, searching again. ANSWER: Odalys Ferro keeps 3 cats.');
  assert.equal(n.join(''), 'Not sure');
  assert.equal(h.finish().text, 'Odalys Ferro keeps 3 cats.');
  // ordinary punctuation inside the line is kept (U.S. and "3.5" are not sentence breaks)
  const k = new MarkerFilter(() => {});
  k.push('ANSWER: It runs in the U.S. East region on 3.5 GHz CPUs.');
  assert.equal(k.finish().text, 'It runs in the U.S. East region on 3.5 GHz CPUs.');
});

test('harness: config defaults (v4 session name, gateway tools, DIGITALOCEAN_ACCESS_TOKEN fallback)', () => {
  const cfg = harnessConfig({ DIGITALOCEAN_ACCESS_TOKEN: 'dop' });
  assert.equal(cfg.token, 'dop');
  assert.equal(harnessConfig({ HARNESS_API_TOKEN: 'h', DIGITALOCEAN_ACCESS_TOKEN: 'dop' }).token, 'h');
  assert.equal(cfg.sessionName, 'alexis-anatomy-harness-v4b');
  assert.equal(cfg.toolsMode, 'gateway');
  assert.equal(cfg.size, 'mars-1vcpu-1gb');
  assert.equal(cfg.idleTimeout, '30m');
  assert.equal(cfg.firstTokenTimeoutMs, 45000);
  // HARNESS_GATEWAY_TOOLS unset / blank -> Action Gateway slugs <serverRef>_<tool> for the anatomy-data server
  assert.deepEqual(cfg.gatewayTools, ['anatomy-data_search_facts', 'anatomy-data_get_document']);
  assert.deepEqual(harnessConfig({ HARNESS_GATEWAY_TOOLS: ' , ' }).gatewayTools, ['anatomy-data_search_facts', 'anatomy-data_get_document']);
  assert.deepEqual(harnessConfig({ HARNESS_GATEWAY_TOOLS: 'custom_search_facts, custom_get_document' }).gatewayTools, ['custom_search_facts', 'custom_get_document']);
  assert.equal(harnessConfig({ HARNESS_TOOLS_MODE: 'inline' }).toolsMode, 'inline');
  assert.equal(harnessConfig({ HARNESS_TOOLS_MODE: 'bogus' }).toolsMode, 'gateway');
  // session hygiene + reasoning effort defaults
  assert.equal(cfg.configId, DEFAULT_CONFIG_ID);
  assert.equal(cfg.configId, '01a132ee-ff11-7130-9d05-838874ecec77');
  assert.equal(cfg.rotateAfter, 15);
  assert.equal(cfg.rotateIdleMs, 20 * 60 * 1000);
  assert.equal(cfg.reasoningEffort, 'off');
  assert.equal(harnessConfig({ HARNESS_CONFIG_ID: 'none' }).configId, '');
  assert.equal(harnessConfig({ HARNESS_CONFIG_ID: '' }).configId, '');
  assert.equal(harnessConfig({ HARNESS_CONFIG_ID: ' abc ' }).configId, 'abc');
  assert.equal(harnessConfig({ HARNESS_ROTATE_AFTER: '0' }).rotateAfter, 0, '0 disables');
  assert.equal(harnessConfig({ HARNESS_ROTATE_IDLE_MS: '0' }).rotateIdleMs, 0);
  assert.equal(harnessConfig({ HARNESS_ROTATE_AFTER: 'x' }).rotateAfter, 15, 'invalid -> default');
  assert.equal(harnessConfig({ HARNESS_REASONING_EFFORT: 'High' }).reasoningEffort, 'high');
  assert.equal(harnessConfig({ HARNESS_REASONING_EFFORT: 'off' }).reasoningEffort, 'off');
  assert.equal(harnessConfig({ HARNESS_REASONING_EFFORT: 'bogus' }).reasoningEffort, 'off');
  assert.equal(harnessConfig({ HARNESS_REASONING_EFFORT: '' }).reasoningEffort, 'off');
});

test('harness: inline manifest declares the anatomy-data MCP server, its secret slot and allow rules', () => {
  const m = buildManifest(harnessConfig({ ...BASE_ENV, HARNESS_TOOLS_MODE: 'inline' }));
  assert.match(m, /^name: alexis-anatomy-harness-v4b$/m);
  assert.match(m, /^agent: opencode$/m);
  assert.match(m, /^size: mars-1vcpu-1gb$/m);
  assert.match(m, /^idle_timeout: 30m$/m);
  assert.match(m, /HARNESS_INFERENCE_MODEL: "openai-gpt-oss-20b"/);
  assert.match(m, /HARNESS_INFERENCE_API_KEY: "k"/);
  assert.match(m, /ANATOMY_MCP_TOKEN: "Bearer mcp-secret"/);
  assert.match(m, /^tools:\n  - name: anatomy-data\n    url: "https:\/\/demo.example\/mcp"\n    tools: \[search_facts, get_document\]\n    auth:\n      header: Authorization\n      secret: ANATOMY_MCP_TOKEN$/m);
  assert.match(m, /default: deny/);
  assert.match(m, /- tool: anatomy-data\/search_facts\n      action: allow/);
  assert.match(m, /- tool: anatomy-data\/get_document\n      action: allow/);
  assert.match(m, /^  manifest: [0-9a-f]{8}$/m);
  assert.match(m, /^  tools-mode: inline$/m);
  assert.doesNotMatch(m, /do\.actions/);
});

test('harness: gateway manifest (default mode, default slugs) selects do.actions tools with preload and allow rules, no MCP secret', () => {
  const m = buildManifest(harnessConfig({ ...BASE_ENV }));
  assert.match(m, /^tools:\n  - do\.actions:\n      tools: \[anatomy-data_search_facts, anatomy-data_get_document\]\n      preload_tools: \[anatomy-data_search_facts, anatomy-data_get_document\]$/m);
  assert.match(m, /- tool: do\.actions\/anatomy-data_search_facts\n      action: allow/);
  assert.match(m, /- tool: do\.actions\/anatomy-data_get_document\n      action: allow/);
  assert.doesNotMatch(m, /ANATOMY_MCP_TOKEN/);
  assert.doesNotMatch(m, /name: anatomy-data/);
  assert.match(m, /^  tools-mode: gateway$/m);
  assert.equal(m, buildManifest(harnessConfig({ ...BASE_ENV, HARNESS_TOOLS_MODE: 'gateway', HARNESS_GATEWAY_TOOLS: 'anatomy-data_search_facts,anatomy-data_get_document' })));
});

test('harness: none manifest has no tools and denies everything; hash differs per mode', () => {
  const none = buildManifest(harnessConfig({ ...BASE_ENV, HARNESS_TOOLS_MODE: 'none' }));
  assert.doesNotMatch(none, /^tools:/m);
  assert.doesNotMatch(none, /ANATOMY_MCP_TOKEN/);
  assert.match(none, /permissions:\n  default: deny\n$/);
  const h = (env) => manifestHash(harnessConfig({ ...BASE_ENV, ...env }));
  assert.notEqual(h({}), h({ HARNESS_TOOLS_MODE: 'none' }));
  assert.notEqual(h({}), h({ HARNESS_TOOLS_MODE: 'inline' }));
  assert.notEqual(h({}), h({ HARNESS_GATEWAY_TOOLS: 'other_search_facts' }));
  assert.notEqual(h({ HARNESS_TOOLS_MODE: 'inline' }), h({ HARNESS_TOOLS_MODE: 'inline', MCP_PUBLIC_URL: 'https://other.example/mcp' }));
  assert.equal(h({}), h({ MCP_AUTH_TOKEN: 'different-secret', HARNESS_INFERENCE_API_KEY: 'other' }), 'secrets do not change the fingerprint');
});

test('harness: prompts', () => {
  const tp = buildToolPrompt('Where does Acme run?');
  assert.match(tp, /MUST call anatomy-data\/search_facts in this turn/);
  assert.match(tp, /get_document only if/);
  assert.match(tp, /Do not use any other tool/);
  assert.match(tp, /ONLY from this turn's tool results/);
  assert.match(tp, /do not know that yet/);
  assert.match(tp, /starts with "ANSWER:"/);
  assert.match(tp, /Question: Where does Acme run\?$/);
  assert.match(buildToolPrompt('q', { gateway: true }), /MUST call the search_facts tool in this turn/);
  assert.match(buildPrompt('q', '[1] ctx'), /do not use any tools[\s\S]*Context:\n\[1\] ctx/);
  // the session keeps its history: both prompts must declare earlier turns stale (facts come and go)
  for (const prompt of [tp, buildToolPrompt('q', { gateway: true }), buildPrompt('q', '[1] ctx')]) {
    assert.match(prompt, /Facts can be added or deleted at any time/);
    assert.match(prompt, /earlier turns is stale and must never be used/);
  }
  assert.match(tp, /Never answer from memory or from an earlier turn/);
  assert.match(buildPrompt('q', ''), /context below is the only source of truth for this turn/);
  // exactly one search per turn; NO_MATCHING_FACTS ends the turn at once with the fixed answer
  assert.equal(DONT_KNOW_TEXT, 'I do not know that yet.');
  for (const prompt of [tp, buildToolPrompt('q', { gateway: true })]) {
    assert.match(prompt, /search_facts[^\n]*exactly once/);
    assert.match(prompt, /Never call it a second time/);
    assert.match(prompt, /If the search result starts with "NO_MATCHING_FACTS", immediately reply with the single line "ANSWER: I do not know that yet\." and nothing else: no further tool calls, no reasoning, no rephrased search\./);
  }
  assert.match(buildPrompt('q', ''), /reply exactly "ANSWER: I do not know that yet\."/);
  assert.ok(isDontKnow("I don't know that yet."));
  assert.ok(isDontKnow('No relevant facts were found.'));
  assert.ok(isDontKnow(''));
  assert.ok(!isDontKnow('Acme runs 40 GPU droplets in SFO3.'));
});

test('harness: the Harness Runtime is the only answer backend (ANSWER_BACKEND / DO_AGENT_* are ignored)', () => {
  const bus = new EventBus();
  const legacyEnv = { DO_AGENT_ENDPOINT: 'https://x.agents.do-ai.run', DO_AGENT_KEY: 'k', ANSWER_BACKEND: 'agent' };
  assert.equal(new RealPipeline(bus, { ...legacyEnv, HARNESS_API_TOKEN: 't' }).describe().inferenceVia, 'harness');
  assert.equal(new RealPipeline(bus, legacyEnv).describe().inferenceVia, null, 'no token -> nothing answers (replay fallback upstream)');
  assert.equal(new RealPipeline(bus, { DIGITALOCEAN_ACCESS_TOKEN: 'dop' }).describe().inferenceVia, 'harness');
  const d = new RealPipeline(bus, BASE_ENV).describe();
  assert.equal(d.toolsMode, 'gateway');
  assert.equal(d.harnessSession, 'alexis-anatomy-harness-v4b');
  assert.ok(!('agent' in d) && !('answerBackend' in d));
});

test('harness: warmUp() finds or creates the session at boot without emitting job events, and never throws', async () => {
  // 1. a matching session exists -> resumed
  let h = fakeHarness([]);
  let { p, events, restore } = setup(BASE_ENV, h);
  const logs = [];
  const log = { log: (m) => logs.push(m), error: (m) => logs.push(`ERR ${m}`) };
  try {
    const out = await p.warmUp(log);
    assert.equal(out.ok, true);
    assert.equal(out.created, false);
    assert.equal(out.session, 'alexis-anatomy-harness-v4b');
    assert.equal(out.sessionId, 'sess-1');
    assert.equal(events.length, 0, 'warm-up is silent on the SSE bus');
    assert.match(logs[0], /\[warm-up\] harness session alexis-anatomy-harness-v4b resumed \(sess-1\)/);
    assert.equal(p.describe().harnessSessionId, 'sess-1');
    // a following question reuses the warm session: no second list / create call
    const before = h.calls.length;
    await p.ask('q');
    assert.ok(!h.calls.slice(before).some((c) => c.url.includes('?name=') || (c.method === 'POST' && c.url.endsWith('/sessions'))), 'session already known');
  } finally {
    restore();
  }
  // 2. nothing exists -> created
  h = fakeHarness([], { sessions: [] });
  ({ p, events, restore } = setup(BASE_ENV, h));
  try {
    const out = await p.warmUp(log);
    assert.equal(out.created, true);
    assert.ok(h.calls.some((c) => c.method === 'POST' && c.url.endsWith('/sessions')));
    assert.equal(events.length, 0);
  } finally {
    restore();
  }
  // 3. API down -> logged, not thrown
  h = fakeHarness([]);
  h.impl = async () => new Response('nope', { status: 500 });
  ({ p, events, restore } = setup(BASE_ENV, h));
  try {
    const out = await p.warmUp(log);
    assert.equal(out.ok, false);
    assert.match(out.error, /Harness list sessions failed: 500/);
    assert.match(logs.at(-1), /^ERR \[warm-up\] harness session not ready/);
    assert.equal(events.length, 0);
  } finally {
    restore();
  }
  // 4. no token -> skipped
  const bus = new EventBus();
  const cold = await new RealPipeline(bus, { DATABASE_URL: 'postgres://stub' }).warmUp(log);
  assert.deepEqual(cold, { ok: false, skipped: true, reason: 'HARNESS_API_TOKEN not set' });
});

test('harness: session reuse by manifest fingerprint; stale base session -> new <name>-<hash> session', async () => {
  const cfg = harnessConfig(BASE_ENV);
  const hash = manifestHash(cfg);
  // 1. matching label -> reuse
  let h = fakeHarness([], { sessions: [{ session_id: 'ok', name: cfg.sessionName, status: 'SESSION_STATUS_PAUSED', labels: { manifest: hash } }] });
  let c = new HarnessClient(cfg, h.impl);
  assert.deepEqual(await c.ensureSession(), { id: 'ok', name: cfg.sessionName, created: false, stale: false });
  // 2. base session exists with a different manifest -> create <name>-<hash>, never delete the old one
  h = fakeHarness([], { sessions: [{ session_id: 'old', name: cfg.sessionName, status: 'SESSION_STATUS_PAUSED', labels: { manifest: 'deadbeef' } }] });
  c = new HarnessClient(cfg, h.impl);
  const made = await c.ensureSession();
  assert.equal(made.created, true);
  assert.equal(made.stale, true);
  assert.equal(made.name, `${cfg.sessionName}-${hash}`);
  assert.ok(h.state.sessions.some((s) => s.session_id === 'old'), 'stale session left alone');
  assert.ok(!h.calls.some((x) => x.method === 'DELETE'));
  const create = h.calls.find((x) => x.method === 'POST' && x.url.endsWith('/sessions'));
  assert.match(create.body, new RegExp(`^name: ${cfg.sessionName}-${hash}$`, 'm'));
  // 3. the variant already exists -> reuse it
  c = new HarnessClient(cfg, h.impl);
  assert.equal((await c.ensureSession()).created, false);
  // 4. nothing exists -> create the base name
  h = fakeHarness([], { sessions: [] });
  c = new HarnessClient(cfg, h.impl);
  assert.deepEqual(await c.ensureSession(), { id: 'sess-1', name: cfg.sessionName, created: true, stale: false });
  // 5. the base was deleted but the variant lives on (the sessions API returns no labels) -> reuse the variant
  h = fakeHarness([], { sessions: [{ session_id: 'var', name: `${cfg.sessionName}-${hash}`, status: 'SESSION_STATUS_READY', labels: null }] });
  c = new HarnessClient(cfg, h.impl);
  assert.deepEqual(await c.ensureSession(), { id: 'var', name: `${cfg.sessionName}-${hash}`, created: false, stale: false });
  assert.ok(!h.calls.some((x) => x.method === 'POST' && x.url.endsWith('/sessions')), 'no new base session');
  // 6. the live API returns no labels at all -> the base name is trusted, no variant is created
  h = fakeHarness([], { sessions: [{ session_id: 'base', name: cfg.sessionName, status: 'SESSION_STATUS_READY', labels: null }, { session_id: 'var', name: `${cfg.sessionName}-${hash}`, status: 'SESSION_STATUS_READY' }] });
  c = new HarnessClient(cfg, h.impl);
  assert.deepEqual(await c.ensureSession(), { id: 'base', name: cfg.sessionName, created: false, stale: false });
});

test('harness: tool path streams the answer, attributes MCP tool events to the job and reports timing', async () => {
  let pipeline;
  const h = fakeHarness(['Thinking... ', 'ANSWER:', ' Acme runs', ' 40 GPU droplets.'], {
    onInput: (text) => {
      assert.match(text, /search_facts/);
      assert.doesNotMatch(text, /Acme Robotics runs 40 GPU droplets/, 'tool path does not pre-retrieve context into the prompt');
      // the MCP server reports the tool call while the run is in flight
      pipeline.handleToolEvent({ phase: 'start', callId: 'c1', tool: 'search_facts', args: { query: 'How many droplets?', k: 3 }, target: 'pgvector' });
      pipeline.handleToolEvent({ phase: 'done', callId: 'c1', tool: 'search_facts', args: { query: 'How many droplets?', k: 3 }, target: 'pgvector', ms: 120, summary: '1 hit', hits: [{ id: 7, score: 0.9, chunk: FACT, object_key: 'facts/1.txt' }] });
    },
  });
  const { p, events, fetches, restore } = setup(BASE_ENV, h);
  pipeline = p;
  try {
    const out = await p.ask('How many droplets?');
    assert.equal(out.answer, 'Acme runs 40 GPU droplets.');
    assert.equal(out.backend, 'harness');
    assert.equal(out.fallback, null);
    assert.equal(out.timing.toolCalls, 1);
    assert.ok(out.timing.totalMs >= 0 && out.timing.firstTokenMs >= 0);
    assert.deepEqual(out.sources.map((s) => s.id), [7]);
    assert.equal(out.sources[0].origin, 'search_facts');
    assert.equal(tokensOf(events), 'Acme runs 40 GPU droplets.');
    assert.deepEqual(starts(events), ['agent', 'inference', 'gateway', 'vectordb'], 'no kb/app-side retrieval on the tool path');
    assert.ok(fetches.some((f) => f.url === 'https://demo.example/mcp/health'), 'MCP health checked before sending');
    const tool = events.filter((e) => e.type === 'tool');
    assert.deepEqual(tool.map((e) => e.data.phase), ['start', 'done']);
    assert.equal(tool[0].jobId, out.jobId);
    assert.equal(tool[1].data.ms, 120);
    const gw = events.filter((e) => e.stage === 'gateway');
    assert.deepEqual(gw.map((e) => e.status), ['start', 'done']);
    assert.match(gw[1].detail, /TOOL search_facts\(query="How many droplets\?", k=3\) → pgvector · 1 hit · 120 ms/);
    assert.equal(gw[1].data.op, 'tool');
    const vdb = events.find((e) => e.stage === 'vectordb' && e.status === 'done');
    assert.deepEqual(vdb.data.hits, [{ id: 7, score: 0.9 }]);
    assert.equal(vdb.data.op, 'tool');
    const agentDone = events.find((e) => e.stage === 'agent' && e.status === 'done');
    assert.equal(agentDone.data.toolCalls, 1);
    assert.equal(typeof agentDone.data.totalMs, 'number');
    const job = events.at(-1);
    assert.equal(job.type, 'job');
    assert.equal(job.data.backend, 'harness');
    assert.equal(job.data.timing.toolCalls, 1);
    assert.ok(events.some((e) => e.type === 'answer' && e.data.sources.length === 1));
  } finally {
    restore();
  }
});

test('harness: fallback 1 when the MCP health check fails: app retrieves, context passed in prompt', async () => {
  const h = fakeHarness(['ANSWER: 40 droplets.'], { onInput: (text) => assert.match(text, /Context:\n\[1\] Acme Robotics runs 40 GPU droplets/) });
  const { p, events, restore } = setup(BASE_ENV, h, { mcpHealthy: false });
  try {
    const out = await p.ask('How many droplets?');
    assert.equal(out.answer, '40 droplets.');
    assert.equal(out.fallback, 'context');
    assert.equal(out.backend, 'harness');
    assert.deepEqual(out.sources.map((s) => s.id), [7]);
    assert.deepEqual(starts(events), ['agent', 'kb', 'vectordb', 'inference']);
    const agentStart = events.find((e) => e.stage === 'agent' && e.status === 'start');
    assert.match(agentStart.detail, /Tool path unavailable, context passed in prompt \(MCP health HTTP 503\)/);
    assert.equal(agentStart.data.fallback, 'context');
  } finally {
    restore();
  }
});

test('harness: HARNESS_TOOLS_MODE=none never checks MCP and passes context in the prompt', async () => {
  const h = fakeHarness(['ANSWER: 40 droplets.']);
  const { p, events, fetches, restore } = setup({ ...BASE_ENV, HARNESS_TOOLS_MODE: 'none' }, h);
  try {
    const out = await p.ask('How many droplets?');
    assert.equal(out.fallback, 'context');
    assert.ok(!fetches.some((f) => f.url.endsWith('/health')));
    assert.match(events.find((e) => e.stage === 'agent' && e.status === 'start').detail, /HARNESS_TOOLS_MODE=none/);
  } finally {
    restore();
  }
});

test('harness: "don\'t know" with a failed tool call (no usable result) is retried once with context in the prompt', async () => {
  const prompts = [];
  let n = 0;
  let pipeline;
  const h = fakeHarness([], {
    onInput: (t) => {
      prompts.push(t);
      // first run: the tool is called but fails, don't-know answer; second run (context in prompt): grounded answer
      if (prompts.length === 1) {
        pipeline.handleToolEvent({ phase: 'start', callId: 'c1', tool: 'search_facts', args: { query: 'How many droplets?' }, target: 'pgvector' });
        pipeline.handleToolEvent({ phase: 'error', callId: 'c1', tool: 'search_facts', args: { query: 'How many droplets?' }, target: 'pgvector', error: 'pg down' });
      }
    },
  });
  const base = h.impl;
  h.impl = async (url, init) => {
    if (String(url).endsWith('/events')) {
      n++;
      const text = n === 1 ? "ANSWER: I don't know that yet." : 'ANSWER: 40 droplets.';
      const evs = [{ type: 'run.started', run_id: 'run-1', data: {} }, { type: 'run.token_delta', run_id: 'run-1', data: { text, is_reasoning: false } }, { type: 'run.completed', run_id: 'run-1', data: {} }];
      return new Response(evs.map(sseFrame).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return base(url, init);
  };
  const { p, events, restore } = setup(BASE_ENV, h);
  pipeline = p;
  try {
    const out = await p.ask('How many droplets?');
    assert.equal(out.answer, '40 droplets.');
    assert.equal(out.fallback, 'context-retry');
    assert.equal(out.timing.toolCalls, 1);
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /search_facts/);
    assert.match(prompts[1], /Context:\n\[1\] Acme Robotics/);
    assert.ok(events.some((e) => e.stage === 'agent' && e.status === 'progress' && /retrying with context passed in prompt/.test(e.detail)));
    assert.deepEqual(starts(events), ['agent', 'inference', 'gateway', 'vectordb', 'kb', 'vectordb', 'inference']);
    assert.equal(tokensOf(events), "I don't know that yet.40 droplets.", 'a tool call was seen, so the first (empty-handed) answer streamed too; the UI replaces it with the final answer');
  } finally {
    restore();
  }
});

/** Fake harness whose first run answers from history without any tool call; a second run (if any) answers from the context prompt. */
function skipsToolHarness(prompts, secondAnswer = 'ANSWER: 40 droplets.') {
  let n = 0;
  const h = fakeHarness([], { onInput: (t) => prompts.push(t) });
  const base = h.impl;
  h.impl = async (url, init) => {
    if (String(url).endsWith('/events')) {
      n++;
      const text = n === 1 ? 'Recalling... ANSWER: Acme runs 40 GPU droplets in SFO3.' : secondAnswer;
      const evs = [{ type: 'run.started', run_id: 'run-1', data: {} }, { type: 'run.token_delta', run_id: 'run-1', data: { text, is_reasoning: false } }, { type: 'run.completed', run_id: 'run-1', data: {} }];
      return new Response(evs.map(sseFrame).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return base(url, init);
  };
  return h;
}

test('harness: guard, no tool call and no matching facts -> the app runs the search itself and answers "I do not know that yet." with no second model run', async () => {
  // The warm session remembers earlier turns: after a fact is deleted the agent can answer confidently
  // from history without calling search_facts. That answer must never reach the audience, and the
  // app must not pay for a second model run when nothing is stored.
  const prompts = [];
  const { p, events, restore } = setup(BASE_ENV, skipsToolHarness(prompts));
  const queries = [];
  p.db = async () => ({ query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } });
  try {
    const out = await p.ask('How many droplets does Acme run?');
    assert.equal(out.answer, 'I do not know that yet.');
    assert.equal(out.fallback, 'guard');
    assert.equal(out.reason, 'no tool call, no matching facts');
    assert.equal(out.backend, 'harness');
    assert.equal(out.timing.toolCalls, 0, 'the model made no tool call; the app-side search is not counted as one');
    assert.deepEqual(out.sources, []);
    assert.equal(prompts.length, 1, 'exactly one model run: no retry with context in the prompt');
    assert.match(prompts[0], /MUST call .*search_facts/);
    assert.equal(queries.length, 1, 'the app ran the pgvector search once');
    assert.match(queries[0].sql, /ORDER BY embedding <=> \$1::vector LIMIT 3/);
    assert.equal(tokensOf(events), 'I do not know that yet.', 'the ungrounded answer was never streamed; the fixed answer was');
    assert.ok(!events.some((e) => e.type === 'stage' && e.data?.token !== undefined && /40 GPU/.test(e.data.token)));
    const discard = events.find((e) => e.stage === 'agent' && e.status === 'progress' && e.data.discarded);
    assert.ok(discard, 'a stage event explains the discard');
    assert.match(discard.detail, /without calling any tool: ungrounded answer discarded unseen \(1 held token\); the app runs search_facts itself/);
    assert.equal(discard.data.guard, 'search');
    assert.equal(discard.data.reason, 'no tool call');
    assert.equal(discard.data.streamed, 0);
    // the same scene events as an MCP-reported search_facts call, marked source `app`
    assert.deepEqual(starts(events), ['agent', 'inference', 'gateway', 'vectordb'], 'no kb/app-side retrieval stage: the search animates through the gateway');
    const tool = events.filter((e) => e.type === 'tool');
    assert.deepEqual(tool.map((e) => [e.data.phase, e.data.source, e.data.tool, e.data.target]), [['start', 'app', 'search_facts', 'pgvector'], ['done', 'app', 'search_facts', 'pgvector']]);
    assert.deepEqual(tool[0].data.args, { query: 'How many droplets does Acme run?', k: 3 });
    assert.equal(tool[1].data.hits, 0);
    assert.equal(tool[1].data.summary, '0 hits');
    assert.equal(typeof tool[1].data.ms, 'number');
    assert.ok(tool.every((e) => e.jobId === out.jobId && e.flow === 'query'));
    const gw = events.filter((e) => e.stage === 'gateway');
    assert.deepEqual(gw.map((e) => e.status), ['start', 'done']);
    assert.match(gw[0].detail, /^TOOL search_facts\(query="How many droplets does Acme run\?", k=3\) → pgvector · run by the app \(harness skipped the tool\)$/);
    assert.match(gw[1].detail, /TOOL search_facts\(query="How many droplets does Acme run\?", k=3\) → pgvector · 0 hits · \d+ ms/);
    assert.equal(gw[1].data.op, 'tool');
    assert.equal(gw[1].data.source, 'app');
    const vdb = events.filter((e) => e.stage === 'vectordb');
    assert.deepEqual(vdb.map((e) => e.status), ['start', 'done']);
    assert.equal(vdb[0].data.op, 'tool');
    assert.deepEqual(vdb[1].data.hits, []);
    assert.equal(vdb[1].data.count, 1);
    const noMatch = events.find((e) => e.stage === 'agent' && e.status === 'progress' && e.data.fallback === 'guard');
    assert.match(noMatch.detail, /No matching facts: answering "I do not know that yet\." without a second model run/);
    const infDone = events.find((e) => e.stage === 'inference' && e.status === 'done');
    assert.match(infDone.detail, /without a second model run/);
    assert.equal(infDone.data.tokens, 1);
    const agentDone = events.find((e) => e.stage === 'agent' && e.status === 'done');
    assert.equal(agentDone.data.fallback, 'guard');
    assert.equal(agentDone.data.toolCalls, 0);
    const job = events.at(-1);
    assert.equal(job.type, 'job');
    assert.equal(job.status, 'done');
    assert.equal(job.data.fallback, 'guard');
    assert.equal(job.data.reason, 'no tool call, no matching facts');
    assert.equal(events.find((e) => e.type === 'answer').data.text, 'I do not know that yet.');
  } finally {
    restore();
  }
});

test('harness: guard, no tool call but matching facts -> app-side search, then exactly one model run with the context in the prompt', async () => {
  const prompts = [];
  const { p, events, restore } = setup(BASE_ENV, skipsToolHarness(prompts));
  const queries = [];
  const db = await p.db();
  p.db = async () => ({ query: async (sql, params) => { queries.push({ sql, params }); return db.query(sql, params); } });
  try {
    const out = await p.ask('How many droplets does Acme run?');
    assert.equal(out.answer, '40 droplets.', 'the final answer comes from the context run, not from history');
    assert.equal(out.fallback, 'context');
    assert.equal(out.reason, 'no tool call');
    assert.equal(out.backend, 'harness');
    assert.equal(out.timing.toolCalls, 0);
    assert.deepEqual(out.sources.map((s) => [s.id, s.origin]), [[7, 'search_facts']], 'sources are the hits of the app-side search');
    assert.equal(prompts.length, 2, 'one single fallback run');
    assert.match(prompts[0], /MUST call .*search_facts/);
    assert.match(prompts[1], /Context:\n\[1\] Acme Robotics runs 40 GPU droplets/);
    assert.equal(queries.length, 1, 'the app searched once; the context run reuses those hits (no second retrieval)');
    assert.equal(tokensOf(events), '40 droplets.', 'the ungrounded answer was never streamed');
    assert.deepEqual(starts(events), ['agent', 'inference', 'gateway', 'vectordb', 'inference']);
    const tool = events.filter((e) => e.type === 'tool');
    assert.deepEqual(tool.map((e) => [e.data.phase, e.data.source]), [['start', 'app'], ['done', 'app']]);
    assert.equal(tool[1].data.hits, 1);
    assert.deepEqual(events.find((e) => e.stage === 'vectordb' && e.status === 'done').data.hits, [{ id: 7, score: 0.9 }]);
    const next = events.find((e) => e.stage === 'agent' && e.status === 'progress' && e.data.fallback === 'context');
    assert.match(next.detail, /1 matching chunk: one model run with the context passed in prompt/);
    assert.equal(next.data.reason, 'no tool call');
    assert.ok(!events.some((e) => e.stage === 'kb'), 'no kb stage: the guard search already animated through the gateway');
    const agentDone = events.find((e) => e.stage === 'agent' && e.status === 'done');
    assert.equal(agentDone.data.fallback, 'context');
    assert.equal(agentDone.data.reason, 'no tool call');
    const job = events.at(-1);
    assert.equal(job.type, 'job');
    assert.equal(job.data.fallback, 'context');
    assert.equal(job.data.reason, 'no tool call');
  } finally {
    restore();
  }
});

test('harness: guard search failure (database down) fails the job with the error reported as a tool error', async () => {
  const prompts = [];
  const { p, events, restore } = setup(BASE_ENV, skipsToolHarness(prompts));
  p.db = async () => { throw new Error('pg down'); };
  try {
    await assert.rejects(p.ask('q'), /pg down/);
    assert.equal(prompts.length, 1, 'no retry with context in the prompt');
    const tool = events.filter((e) => e.type === 'tool');
    assert.deepEqual(tool.map((e) => [e.data.phase, e.data.source]), [['start', 'app'], ['error', 'app']]);
    assert.equal(tool[1].data.error, 'pg down');
    assert.ok(events.some((e) => e.stage === 'gateway' && e.status === 'error' && /pg down/.test(e.detail)));
    assert.equal(events.at(-1).type, 'job');
    assert.equal(events.at(-1).status, 'error');
  } finally {
    restore();
  }
});

test('harness: NO_MATCHING_FACTS tool result + "I do not know that yet." answer is final: no retry of any kind', async () => {
  let pipeline;
  const prompts = [];
  const h = fakeHarness(['ANSWER: I do not know that yet.'], {
    onInput: (text) => {
      prompts.push(text);
      pipeline.handleToolEvent({ phase: 'start', callId: 'c1', tool: 'search_facts', args: { query: 'What colour is the sky?', k: 3 }, target: 'pgvector' });
      pipeline.handleToolEvent({ phase: 'done', callId: 'c1', tool: 'search_facts', args: { query: 'What colour is the sky?', k: 3 }, target: 'pgvector', ms: 40, summary: '0 hits', hits: [] });
    },
  });
  const { p, events, restore } = setup(BASE_ENV, h);
  pipeline = p;
  try {
    const out = await p.ask('What colour is the sky?');
    assert.equal(out.answer, 'I do not know that yet.');
    assert.equal(out.fallback, null);
    assert.equal(out.reason, null);
    assert.equal(out.timing.toolCalls, 1);
    assert.deepEqual(out.sources, []);
    assert.equal(prompts.length, 1);
    assert.deepEqual(starts(events), ['agent', 'inference', 'gateway', 'vectordb']);
    assert.equal(tokensOf(events), 'I do not know that yet.');
    assert.ok(!events.some((e) => e.stage === 'kb'));
  } finally {
    restore();
  }
});

test('harness: tool path holds answer tokens until a tool call is observed, then streams them in order', async () => {
  let pipeline;
  let tokensBeforeTool = -1;
  const h = fakeHarness([]);
  const base = h.impl;
  h.impl = async (url, init) => {
    if (String(url).endsWith('/events')) {
      // tokens arrive BEFORE the MCP server's report of the tool call (webhook latency), then more after it
      const frames = (evs) => new TextEncoder().encode(evs.map((e) => sseFrame({ ...e, run_id: 'run-1' })).join(''));
      const body = new ReadableStream({
        async start(ctrl) {
          ctrl.enqueue(frames([{ type: 'run.started', data: {} }, { type: 'run.token_delta', data: { text: 'ANSWER: Acme', is_reasoning: false } }, { type: 'run.token_delta', data: { text: ' runs', is_reasoning: false } }]));
          await new Promise((r) => setTimeout(r, 20));
          tokensBeforeTool = tokensOf(pipelineEvents).length;
          pipeline.handleToolEvent({ phase: 'start', callId: 'c1', tool: 'search_facts', args: { query: 'q' }, target: 'pgvector' });
          pipeline.handleToolEvent({ phase: 'done', callId: 'c1', tool: 'search_facts', args: { query: 'q' }, target: 'pgvector', summary: '1 hit', hits: [{ id: 7, score: 0.9, chunk: FACT, object_key: 'facts/1.txt' }] });
          ctrl.enqueue(frames([{ type: 'run.token_delta', data: { text: ' 40 GPU droplets.', is_reasoning: false } }, { type: 'run.completed', data: { total_tokens_in: 1, total_tokens_out: 3 } }]));
          ctrl.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return base(url, init);
  };
  const { p, events, restore } = setup(BASE_ENV, h);
  const pipelineEvents = events;
  pipeline = p;
  try {
    const out = await p.ask('q');
    assert.equal(tokensBeforeTool, 0, 'nothing streamed before the tool call was seen');
    assert.equal(out.answer, 'Acme runs 40 GPU droplets.');
    assert.equal(out.fallback, null);
    assert.equal(out.timing.toolCalls, 1);
    assert.deepEqual(out.sources.map((s) => s.id), [7]);
    const toks = events.filter((e) => e.type === 'stage' && e.stage === 'inference' && e.status === 'progress');
    assert.deepEqual(toks.map((e) => e.data.token), ['Acme', ' runs', ' 40 GPU droplets.']);
    assert.deepEqual(toks.map((e) => e.data.index), [0, 1, 2]);
    assert.ok(typeof out.timing.firstTokenMs === 'number' && out.timing.firstTokenMs >= 0);
    assert.ok(!events.some((e) => e.data?.discarded));
  } finally {
    restore();
  }
});

test('harness: the first-token timeout and a pre-token failure surface as errors (no agent fallback; replay fallback upstream)', async () => {
  const hang = fakeHarness([], { hang: true });
  const env = { ...BASE_ENV, HARNESS_FIRST_TOKEN_TIMEOUT_MS: '60' };
  let s = setup(env, hang);
  try {
    await assert.rejects(s.p.ask('q'), /produced nothing within 60 ms/);
    assert.ok(!s.events.some((e) => e.type === 'fallback'), 'no fallback event: the pipeline has no second backend');
    assert.ok(!s.fetches.some((f) => f.url.endsWith('/chat/completions')), 'no Managed Agent / direct inference call');
    assert.equal(s.events.at(-1).type, 'job');
    assert.equal(s.events.at(-1).status, 'error');
    assert.equal(s.p.activeRun, null, 'active run cleared');
  } finally {
    s.restore();
  }
  // tokens then failure: same outcome
  const mid = fakeHarness(['ANSWER: partial'], { fail: true });
  s = setup(env, mid);
  try {
    await assert.rejects(s.p.ask('q'), /Harness run failed: boom/);
    assert.ok(!s.events.some((e) => e.type === 'fallback'));
    assert.equal(s.events.at(-1).status, 'error');
  } finally {
    s.restore();
  }
});

test('harness: a run that fails before the first token surfaces as an error (replay fallback upstream)', async () => {
  const h = fakeHarness([], { fail: true });
  const { p, events, restore } = setup(BASE_ENV, h);
  try {
    await assert.rejects(p.ask('q'), /Harness run failed: boom/);
    assert.equal(events.at(-1).type, 'job');
    assert.equal(events.at(-1).status, 'error');
    assert.equal(p.activeRun, null, 'active run cleared');
  } finally {
    restore();
  }
});

test('harness: normalizeToolName strips gateway/MCP prefixes and toolTarget maps to pgvector/spaces', () => {
  for (const n of ['do_actions_anatomy-data_search_facts', 'do.actions/anatomy-data/search_facts', 'do.actions/anatomy-data_search_facts', 'anatomy-data_search_facts', 'anatomy-data/search_facts', 'search_facts']) {
    assert.equal(normalizeToolName(n), 'search_facts', n);
    assert.equal(toolTarget(n), 'pgvector', n);
  }
  assert.equal(normalizeToolName('do_actions_anatomy-data_get_document'), 'get_document');
  assert.equal(toolTarget('anatomy-data/get_document'), 'spaces');
  assert.equal(normalizeToolName('run.tool_call_completed'), '', 'event types are not tool names');
  assert.equal(normalizeToolName(undefined), '');
  assert.equal(normalizeToolName('bash'), 'bash');
  assert.equal(toolTarget('bash'), null);
});

test('harness: tool-call events in the harness SSE stream are forwarded as tool events with source harness', async () => {
  const extraEvents = [
    { type: 'run.tool_call_started', data: { tool: 'do_actions_anatomy-data_search_facts', input: { query: 'q' }, call_id: 'c1' } },
    { type: 'run.tool_call_completed', data: { call_id: 'c1' } },
    { type: 'run.tool_call', data: { tool: 'do.actions/anatomy-data/get_document', input: { key: 'facts/1.txt' } } },
    { type: 'run.tool_call', data: { name: 'anatomy-data_search_facts', args: { query: 'q2' } } },
    { type: 'run.tool_call_completed', data: {} },
    { type: 'run.tool_call_failed', data: { error: 'boom' } },
    { type: 'run.something_new', data: {} },
  ];
  const h = fakeHarness(['ANSWER: ok'], { extraEvents });
  const { p, events, restore } = setup(BASE_ENV, h);
  const debug = [];
  p.harness.log = { debug: (m) => debug.push(m) };
  try {
    const out = await p.ask('q');
    assert.equal(out.fallback, null, 'tool calls seen on the harness stream count as observed: no stale-history discard');
    assert.equal(out.answer, 'ok');
    assert.equal(tokensOf(events), 'ok');
    const tool = events.filter((e) => e.type === 'tool' && e.data.source === 'harness').map((e) => e.data);
    assert.deepEqual(tool.map((d) => d.phase), ['start', 'done', 'start', 'start', 'done', 'error']);
    assert.deepEqual(tool.map((d) => d.tool), ['search_facts', 'search_facts', 'get_document', 'search_facts', 'search_facts', 'get_document']);
    assert.deepEqual(tool.map((d) => d.target), ['pgvector', 'pgvector', 'spaces', 'pgvector', 'pgvector', 'spaces']);
    // completed-by-id reuses the started call's args; completed-without-id reuses the most recent started call
    assert.deepEqual(tool[1].args, { query: 'q' });
    assert.equal(tool[1].callId, 'c1');
    assert.deepEqual(tool[4].args, { query: 'q2' });
    assert.deepEqual(tool[5].args, { key: 'facts/1.txt' });
    assert.equal(tool[5].error, 'boom');
    assert.equal(tool[0].slug, 'do_actions_anatomy-data_search_facts');
    assert.equal(tool[1].harnessType, 'run.tool_call_completed');
    assert.ok(tool.every((d) => d.summary === undefined), 'event types no longer leak into the log summary');
    assert.deepEqual(debug, ['[harness] unhandled event type run.something_new']);
    await p.ask('q');
    assert.equal(debug.length, 1, 'unknown types are logged once');
  } finally {
    restore();
  }
});

/** Fake harness whose runs are scripted per call: `runs[i]` is { text?, deltas?, extraEvents? } for the i-th run. */
function scriptedHarness(runs, { onInput } = {}) {
  let n = 0;
  const h = fakeHarness([], { onInput });
  const base = h.impl;
  h.impl = async (url, init) => {
    if (String(url).endsWith('/events')) {
      const r = runs[Math.min(n++, runs.length - 1)];
      const deltas = r.deltas || [r.text];
      const evs = [
        { type: 'run.started', run_id: 'run-1', data: {} },
        ...(r.extraEvents || []).map((e) => ({ ...e, run_id: 'run-1' })),
        ...deltas.map((text) => ({ type: 'run.token_delta', run_id: 'run-1', data: { text, is_reasoning: false } })),
        { type: 'run.completed', run_id: 'run-1', data: { total_tokens_in: 10, total_tokens_out: 3 } },
      ];
      return new Response(evs.map(sseFrame).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return base(url, init);
  };
  return h;
}

const REASONING = 'We need to search for the droplets. The tool returned something odd; let me think about it. I should answer that I do not know.';

test('harness: a normal ANSWER: stream reports noMarker false, no invalid tool, and strips Harmony junk after the line', async () => {
  const h = fakeHarness(['Let me check. ', 'ANSWER: Acme', ' runs 40 GPU droplets.', '<|end|><|start|>assistant<|channel|>analysis<|message|>Done.'], {
    extraEvents: [{ type: 'run.tool_call_started', data: { tool: 'do_actions_anatomy-data_search_facts', input: { query: 'q', k: 3 }, call_id: 'c1' } }, { type: 'run.tool_call_completed', data: { call_id: 'c1' } }],
  });
  const toolEvents = [];
  const tokens = [];
  const c = new HarnessClient(harnessConfig(BASE_ENV), h.impl);
  const out = await c.ask('q', { onToolEvent: (t) => toolEvents.push(t), onToken: (t) => tokens.push(t) });
  assert.equal(out.text, 'Acme runs 40 GPU droplets.');
  assert.equal(out.noMarker, false);
  assert.equal(out.invalidTool, 0);
  assert.equal(out.harnessToolEvents, 2);
  assert.deepEqual(toolEvents.map((t) => t.invalid), [false, false]);
  assert.equal(tokens.join(''), 'Acme runs 40 GPU droplets.');
  assert.ok(tokens.every((t) => !/<\||assistant|Let me check/.test(t)));

  // through the pipeline: the junk never reaches the inference token events or the answer
  const { p, events, restore } = setup(BASE_ENV, fakeHarness(['ANSWER: Acme runs 40 GPU droplets.', '<|end|><|start|>assistant<|channel|>analysis<|message|>Done.'], {
    extraEvents: [{ type: 'run.tool_call_started', data: { tool: 'do_actions_anatomy-data_search_facts', input: { query: 'q', k: 3 }, call_id: 'c1' } }, { type: 'run.tool_call_completed', data: { call_id: 'c1' } }],
  }));
  try {
    const res = await p.ask('q');
    assert.equal(res.answer, 'Acme runs 40 GPU droplets.');
    assert.equal(res.fallback, null);
    assert.equal(tokensOf(events), 'Acme runs 40 GPU droplets.');
    assert.ok(!events.some((e) => e.data?.discarded));
    assert.ok(events.filter((e) => e.type === 'tool').every((e) => e.data.invalid === false));
  } finally {
    restore();
  }
});

test('harness: reasoning without ANSWER: on the tool path leaks no token and goes through the guard path', async () => {
  // run 1: a real search_facts call (MCP-reported) but the model only reasons and never writes ANSWER:
  // run 2 (context in prompt after the app-side guard search): a clean answer
  let pipeline;
  const prompts = [];
  const h = scriptedHarness([{ deltas: REASONING.split(/(?<=\. )/) }, { text: 'ANSWER: 40 droplets.' }], {
    onInput: (t) => {
      prompts.push(t);
      if (prompts.length === 1) {
        pipeline.handleToolEvent({ phase: 'start', callId: 'c1', tool: 'search_facts', args: { query: 'How many droplets?', k: 3 }, target: 'pgvector' });
        pipeline.handleToolEvent({ phase: 'done', callId: 'c1', tool: 'search_facts', args: { query: 'How many droplets?', k: 3 }, target: 'pgvector', ms: 50, summary: '1 hit', hits: [{ id: 7, score: 0.9, chunk: FACT, object_key: 'facts/1.txt' }] });
      }
    },
  });
  const { p, events, restore } = setup(BASE_ENV, h);
  pipeline = p;
  try {
    const out = await p.ask('How many droplets?');
    assert.equal(out.answer, '40 droplets.');
    assert.equal(out.fallback, 'context');
    assert.equal(out.reason, 'no ANSWER: line');
    assert.equal(out.timing.toolCalls, 1, 'the real tool call still counts');
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /Context:\n\[1\] Acme Robotics runs 40 GPU droplets/);
    assert.equal(tokensOf(events), '40 droplets.', 'no reasoning token was streamed');
    assert.ok(!events.some((e) => e.type === 'stage' && e.data?.token !== undefined && /search|think|know/.test(e.data.token)));
    const discard = events.find((e) => e.data?.discarded);
    assert.ok(discard);
    assert.equal(discard.data.reason, 'no ANSWER: line');
    assert.equal(discard.data.noMarker, true);
    assert.equal(discard.data.streamed, 0);
    assert.equal(discard.data.held, 0);
    assert.match(discard.detail, /without an ANSWER: line: nothing after ANSWER: was produced, so nothing was streamed; the app runs search_facts itself/);
    // the guard search animates through the gateway (source app) after the model's own call
    const tool = events.filter((e) => e.type === 'tool');
    assert.deepEqual(tool.map((e) => [e.data.phase, e.data.source]), [['start', 'mcp'], ['done', 'mcp'], ['start', 'app'], ['done', 'app']]);
    assert.deepEqual(starts(events), ['agent', 'inference', 'gateway', 'vectordb', 'gateway', 'vectordb', 'inference']);
    assert.equal(events.find((e) => e.type === 'answer').data.text, '40 droplets.');
  } finally {
    restore();
  }

  // the context run is held to the same rule: no ANSWER: there either -> "I do not know that yet.", streamed as the only token
  const prompts2 = [];
  const h2 = scriptedHarness([{ text: REASONING }, { text: 'Hmm, the context says 40 but I am not sure. ' }], { onInput: (t) => prompts2.push(t) });
  const second = setup(BASE_ENV, h2);
  try {
    const out = await second.p.ask('How many droplets?');
    assert.equal(out.answer, DONT_KNOW_TEXT);
    assert.equal(out.fallback, 'context');
    assert.equal(out.reason, 'no tool call');
    assert.equal(prompts2.length, 2);
    assert.equal(tokensOf(second.events), DONT_KNOW_TEXT);
    assert.ok(second.events.some((e) => e.stage === 'agent' && e.status === 'progress' && e.data.noMarker && /Context run produced no ANSWER: line/.test(e.detail)));
    assert.equal(second.events.find((e) => e.type === 'answer').data.text, DONT_KNOW_TEXT);
  } finally {
    second.restore();
  }
});

test('harness: an invalid tool call (malformed search_facts call, model rambles) never counts as a tool call; the guard answers, no reasoning leaks', async () => {
  // OpenCode reports a malformed do_actions_anatomy-data_search_facts call as tool `invalid`; the model then
  // rambles in plain text and never writes ANSWER:. No MCP-reported tool event arrives (the call never reached the server).
  const prompts = [];
  const extraEvents = [
    { type: 'run.tool_call_started', data: { tool: 'invalid', input: { tool: 'do_actions_anatomy-data_search_facts', error: 'Invalid JSON arguments' }, call_id: 'c1' } },
    { type: 'run.tool_call_completed', data: { call_id: 'c1', status: 'error', error: 'The arguments provided to the tool are invalid' } },
  ];
  const ramble = ['The tool call failed because the arguments were malformed. ', 'Acme Robotics runs 40 GPU droplets in SFO3 according to my memory. ', 'I should answer from what I remember.'];

  // HarnessClient level: the invalid events are counted apart and flagged to the hook
  const c = new HarnessClient(harnessConfig(BASE_ENV), fakeHarness(ramble, { extraEvents }).impl);
  const seen = [];
  const tokens = [];
  const out = await c.ask('q', { onToolEvent: (t) => seen.push(t), onToken: (t) => tokens.push(t) });
  assert.deepEqual({ text: out.text, noMarker: out.noMarker, invalidTool: out.invalidTool, harnessToolEvents: out.harnessToolEvents }, { text: '', noMarker: true, invalidTool: 2, harnessToolEvents: 0 });
  assert.deepEqual(seen.map((t) => t.invalid), [true, true], 'the completion event of an invalid call is flagged too');
  assert.deepEqual(tokens, []);

  // pipeline level, nothing stored: guard search, instant "I do not know that yet.", one model run
  const { p, events, restore } = setup(BASE_ENV, fakeHarness(ramble, { extraEvents, onInput: (t) => prompts.push(t) }));
  const queries = [];
  p.db = async () => ({ query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } });
  try {
    const res = await p.ask('How many droplets does Acme run?');
    assert.equal(res.answer, DONT_KNOW_TEXT);
    assert.equal(res.fallback, 'guard');
    assert.equal(res.reason, 'invalid tool call, no matching facts');
    assert.equal(res.timing.toolCalls, 0);
    assert.deepEqual(res.sources, []);
    assert.equal(prompts.length, 1, 'no second model run');
    assert.equal(queries.length, 1, 'the app ran the search itself');
    assert.equal(tokensOf(events), DONT_KNOW_TEXT, 'the rambling never streamed');
    assert.ok(!events.some((e) => e.type === 'stage' && e.data?.token !== undefined && /memory|malformed|40 GPU/.test(e.data.token)));
    assert.equal(events.find((e) => e.type === 'answer').data.text, DONT_KNOW_TEXT);
    const discard = events.find((e) => e.data?.discarded);
    assert.equal(discard.data.reason, 'invalid tool call');
    assert.equal(discard.data.invalidTool, 2);
    assert.match(discard.detail, /Harness made 2 invalid\/failed tool calls and no clean answer/);
    const tool = events.filter((e) => e.type === 'tool');
    assert.deepEqual(tool.map((e) => [e.data.source, e.data.phase, e.data.tool, e.data.invalid]), [['harness', 'start', 'invalid', true], ['harness', 'done', 'invalid', true], ['app', 'start', 'search_facts', undefined], ['app', 'done', 'search_facts', undefined]]);
    assert.equal(tool[0].data.target, undefined, 'an invalid call reaches no target');
    assert.equal(events.at(-1).data.reason, 'invalid tool call, no matching facts');
  } finally {
    restore();
  }

  // pipeline level, a matching fact stored: guard search finds it, one context run gives the clean answer
  const prompts2 = [];
  const h2 = scriptedHarness([{ deltas: ramble, extraEvents }, { text: 'ANSWER: 40 droplets.' }], { onInput: (t) => prompts2.push(t) });
  const second = setup(BASE_ENV, h2);
  try {
    const res = await second.p.ask('How many droplets does Acme run?');
    assert.equal(res.answer, '40 droplets.');
    assert.equal(res.fallback, 'context');
    assert.equal(res.reason, 'invalid tool call');
    assert.equal(prompts2.length, 2);
    assert.equal(tokensOf(second.events), '40 droplets.');
    assert.deepEqual(res.sources.map((s) => s.id), [7]);
  } finally {
    second.restore();
  }
});

test('harness: tool events arriving with no active question are published unattributed', () => {
  const bus = new EventBus();
  const events = [];
  bus.on('event', (e) => events.push(e));
  const p = new RealPipeline(bus, BASE_ENV);
  assert.deepEqual(p.handleToolEvent({ phase: 'done', tool: 'search_facts', hits: [] }), { accepted: false });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'tool');
  assert.equal(events[0].jobId, null);
});

test('harness: prompts carry the language rules; the "don\'t know" line follows the question\'s language, the ANSWER: marker does not', () => {
  const en = buildToolPrompt('Where does Acme run?');
  const es = buildToolPrompt('¿Dónde corre Acme?');
  for (const prompt of [en, es, buildToolPrompt('q', { gateway: true }), buildPrompt('Where does Acme run?', '[1] ctx'), buildPrompt('¿Dónde corre Acme?', '')]) {
    assert.match(prompt, /same language as the question/);
    assert.match(prompt, /Spanish "Todavía no lo sé\."/);
    assert.match(prompt, /always starts with "ANSWER:"/);
  }
  for (const prompt of [en, es, buildToolPrompt('q', { gateway: true })]) {
    assert.match(prompt, /Pass the question as `query` exactly as the user wrote it, in its own language: never translate, rephrase or shorten it \(the embedder is multilingual\)/);
  }
  assert.match(en, /If the search result starts with "NO_MATCHING_FACTS", immediately reply with the single line "ANSWER: I do not know that yet\." and nothing else/);
  assert.match(es, /If the search result starts with "NO_MATCHING_FACTS", immediately reply with the single line "ANSWER: Todavía no lo sé\." and nothing else/);
  assert.match(es, /reply with that same line: "ANSWER: Todavía no lo sé\."/);
  assert.match(es, /Question: ¿Dónde corre Acme\?$/, 'the question is passed verbatim');
  assert.match(buildPrompt('¿Dónde corre Acme?', ''), /reply exactly "ANSWER: Todavía no lo sé\."/);
  assert.match(buildPrompt('Where does Acme run?', ''), /reply exactly "ANSWER: I do not know that yet\."/);
  // the retry heuristic understands the Spanish line too
  assert.ok(isDontKnow('Todavía no lo sé.'));
  assert.ok(isDontKnow('No lo sé.'));
  assert.ok(isDontKnow('No tengo esa información.'));
  assert.ok(!isDontKnow('Acme tiene 40 droplets GPU en SFO3.'));
});

test('harness: the app-side guard answers "Todavía no lo sé." for a Spanish question when nothing matches', async () => {
  const ramble = ['I will answer from memory: Acme runs 40 GPU droplets.'];
  const prompts = [];
  const { p, events, restore } = setup(BASE_ENV, fakeHarness(ramble, { onInput: (t) => prompts.push(t) }));
  const queries = [];
  p.db = async () => ({ query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } });
  try {
    const res = await p.ask('¿Cuántos droplets tiene Acme?');
    assert.equal(res.answer, 'Todavía no lo sé.');
    assert.equal(res.fallback, 'guard');
    assert.equal(res.reason, 'no tool call, no matching facts');
    assert.equal(prompts.length, 1, 'no second model run');
    assert.equal(queries.length, 1, 'the app ran the search itself');
    assert.equal(tokensOf(events), 'Todavía no lo sé.');
    assert.equal(events.find((e) => e.type === 'answer').data.text, 'Todavía no lo sé.');
    assert.ok(events.some((e) => e.stage === 'agent' && /answering "Todavía no lo sé\."/.test(e.detail)));
  } finally {
    restore();
  }
  // same question in English -> English line
  const en = setup(BASE_ENV, fakeHarness(ramble));
  en.p.db = async () => ({ query: async () => ({ rows: [] }) });
  try {
    assert.equal((await en.p.ask('How many droplets does Acme have?')).answer, DONT_KNOW_TEXT);
  } finally {
    en.restore();
  }
});

// ---- reasoning effort (gpt-oss Harmony "Reasoning: low" line) ----------------------------------

test('harness: prompts start with "Reasoning: <effort>" when an effort is given and have no such line when off/empty', () => {
  assert.equal(reasoningLine('low'), 'Reasoning: low');
  assert.equal(reasoningLine('High'), 'Reasoning: high');
  assert.equal(reasoningLine('off'), '');
  assert.equal(reasoningLine(''), '');
  assert.equal(reasoningLine(undefined), '');
  for (const effort of ['low', 'medium', 'high']) {
    assert.equal(buildToolPrompt('q', { effort }).split('\n')[0], `Reasoning: ${effort}`);
    assert.equal(buildToolPrompt('q', { gateway: true, effort }).split('\n')[0], `Reasoning: ${effort}`);
    assert.equal(buildPrompt('q', '[1] ctx', { effort }).split('\n')[0], `Reasoning: ${effort}`);
  }
  // the very first line, exactly once, and the rest of the prompt is unchanged
  const withLine = buildToolPrompt('Where does Acme run?', { effort: 'low' });
  const without = buildToolPrompt('Where does Acme run?', { effort: 'off' });
  assert.equal(withLine, `Reasoning: low\n${without}`);
  assert.equal((withLine.match(/^Reasoning:/gm) || []).length, 1);
  for (const prompt of [without, buildToolPrompt('q'), buildPrompt('q', ''), buildPrompt('q', '', { effort: 'off' }), buildPrompt('q', '', { effort: '' })]) {
    assert.doesNotMatch(prompt, /^Reasoning:/m);
    assert.match(prompt, /^You are the answering step of a retrieval pipeline/);
  }
  // the ANSWER: marker rule and the language rule are untouched
  assert.match(withLine, /starts with "ANSWER:"/);
  assert.match(withLine, /Write the answer in the same language as the question/);
  assert.match(buildPrompt('q', '', { effort: 'low' }), /reply exactly "ANSWER: I do not know that yet\."/);
});

test('harness: the pipeline sends the configured reasoning effort as the first prompt line (low sends the line; default off sends none) and sums reasoning tokens into timing', async () => {
  const prompts = [];
  const usage = { input_tokens: 100, output_tokens: 5, cached_input_tokens: 0, reasoning_tokens: 42 };
  let h = fakeHarness(['ANSWER: 40 droplets.'], { onInput: (t) => prompts.push(t), usage });
  let { p, events, restore } = setup({ ...BASE_ENV, HARNESS_TOOLS_MODE: 'none', HARNESS_REASONING_EFFORT: 'low' }, h);
  try {
    const out = await p.ask('How many droplets?');
    assert.equal(out.answer, '40 droplets.');
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].split('\n')[0], 'Reasoning: low');
    assert.equal(out.timing.reasoningTokens, 42);
    assert.equal(out.timing.toolCalls, 0);
    assert.equal(events.find((e) => e.stage === 'agent' && e.status === 'done').data.reasoningTokens, 42);
    assert.match(events.find((e) => e.stage === 'agent' && e.status === 'done').detail, /42 reasoning tokens/);
    assert.equal(events.at(-1).data.timing.reasoningTokens, 42);
    assert.equal(p.describe().harnessReasoningEffort, 'low');
  } finally {
    restore();
  }
  // tool path too, with a high effort
  prompts.length = 0;
  let pipeline;
  h = fakeHarness(['ANSWER: 40 droplets.'], {
    usage,
    onInput: (t) => {
      prompts.push(t);
      pipeline.handleToolEvent({ phase: 'start', callId: 'c1', tool: 'search_facts', args: { query: 'q', k: 3 }, target: 'pgvector' });
      pipeline.handleToolEvent({ phase: 'done', callId: 'c1', tool: 'search_facts', args: { query: 'q', k: 3 }, target: 'pgvector', ms: 5, summary: '1 hit', hits: [{ id: 7, score: 0.9, chunk: FACT, object_key: 'facts/1.txt' }] });
    },
  });
  ({ p, events, restore } = setup({ ...BASE_ENV, HARNESS_REASONING_EFFORT: 'high' }, h));
  pipeline = p;
  try {
    const out = await p.ask('How many droplets?');
    assert.equal(out.answer, '40 droplets.');
    assert.equal(prompts[0].split('\n')[0], 'Reasoning: high');
    assert.match(prompts[0], /MUST call the search_facts tool/);
    assert.equal(out.fallback, null, 'one grounded run');
    assert.equal(out.timing.reasoningTokens, 42);
  } finally {
    restore();
  }
  // off -> no line at all, and no usage block -> 0 reasoning tokens
  prompts.length = 0;
  h = fakeHarness(['ANSWER: 40 droplets.'], { onInput: (t) => prompts.push(t) });
  ({ p, events, restore } = setup({ ...BASE_ENV, HARNESS_TOOLS_MODE: 'none', HARNESS_REASONING_EFFORT: 'off' }, h));
  try {
    const out = await p.ask('How many droplets?');
    assert.doesNotMatch(prompts[0], /^Reasoning:/m);
    assert.match(prompts[0], /^You are the answering step/);
    assert.equal(out.timing.reasoningTokens, 0);
    assert.equal(p.describe().harnessReasoningEffort, 'off');
  } finally {
    restore();
  }
});

// ---- session hygiene: config-based creation, resolution by name prefix, rotation ----------------

test('harness: with HARNESS_CONFIG_ID the session is created with the JSON form {name, config_id}: no YAML, no new config, no inference key needed', async () => {
  const cfg = harnessConfig({ HARNESS_API_TOKEN: 'tok', HARNESS_CONFIG_ID: CONFIG_ID });
  assert.equal(cfg.inferenceKey, '');
  const h = fakeHarness([], { sessions: [] });
  const c = new HarnessClient(cfg, h.impl, quiet);
  const s = await c.ensureSession();
  assert.equal(s.created, true);
  assert.match(s.name, /^alexis-anatomy-harness-v4b-r[0-9a-z]+$/, 'a fresh session gets the -r<ts> suffix');
  assert.equal(c.sessionId, 'sess-1');
  const create = h.calls.find((x) => x.method === 'POST' && x.url.endsWith('/sessions'));
  assert.equal(create.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(create.body), { name: s.name, config_id: CONFIG_ID });
  assert.doesNotMatch(create.body, /agent:|secrets:|HARNESS_INFERENCE_API_KEY|tools:/);
  // the lookup paged through the full list (no ?name= filter: rotated names vary)
  assert.ok(h.calls.some((x) => x.url.includes('?per_page=')));
  assert.ok(!h.calls.some((x) => x.url.includes('?name=')));
  // naming helpers
  assert.equal(rotatedName('base', 35), 'base-rz');
  assert.ok(isSessionOf('base', 'base'));
  assert.ok(isSessionOf('base', 'base-rabc'));
  assert.ok(!isSessionOf('base', 'base-deadbeef'), 'manifest-hash variants are not rotations');
  assert.ok(!isSessionOf('base', 'base2'));
  // the YAML path is still used when the config id is explicitly off
  const y = fakeHarness([], { sessions: [] });
  const yc = new HarnessClient(harnessConfig({ ...BASE_ENV, HARNESS_CONFIG_ID: 'none' }), y.impl, quiet);
  await yc.ensureSession();
  const yCreate = y.calls.find((x) => x.method === 'POST' && x.url.endsWith('/sessions'));
  assert.equal(yCreate.headers['content-type'], 'application/x-yaml');
  assert.match(yCreate.body, /^name: alexis-anatomy-harness-v4b$/m);
});

test('harness: boot resolution picks the newest live session named <base> or <base>-r<ts> from the config and deletes older duplicates', async () => {
  const base = 'alexis-anatomy-harness-v4b';
  const at = (d) => new Date(Date.UTC(2026, 9, d)).toISOString();
  const sessions = [
    { session_id: 'other', name: 'someone-else', status: 'SESSION_STATUS_READY', config_id: CONFIG_ID, created_at: at(9) },
    { session_id: 'base', name: base, status: 'SESSION_STATUS_PAUSED', config_id: CONFIG_ID, created_at: at(1) },
    { session_id: 'dead', name: `${base}-rzzz`, status: 'SESSION_STATUS_DESTROYED', config_id: CONFIG_ID, created_at: at(8) },
    { session_id: 'failed', name: `${base}-ryyy`, status: 'SESSION_STATUS_FAILED', config_id: CONFIG_ID, created_at: at(7) },
    { session_id: 'otherCfg', name: `${base}-rxxx`, status: 'SESSION_STATUS_READY', config_id: 'another-config', created_at: at(6) },
    { session_id: 'hashVariant', name: `${base}-deadbeef`, status: 'SESSION_STATUS_READY', config_id: CONFIG_ID, created_at: at(6) },
    { session_id: 'r2', name: `${base}-raaa`, status: 'SESSION_STATUS_PAUSED', config_id: CONFIG_ID, created_at: at(3) },
    { session_id: 'r3', name: `${base}-rbbb`, status: 'SESSION_STATUS_READY', created_at: at(5) }, // config_id not returned -> trusted
    { session_id: 'r1', name: `${base}-rccc`, status: 'SESSION_STATUS_READY', config_id: CONFIG_ID, created_at: at(2) },
  ];
  // page size 2 forces paging through the whole list
  const h = fakeHarness([], { sessions: sessions.map((s) => ({ ...s })), perPage: 2 });
  const { p, events, restore } = setup(CONFIG_ENV, h);
  p.harness.log = quiet;
  try {
    const logs = [];
    const out = await p.warmUp({ log: (m) => logs.push(m), error: (m) => logs.push(`ERR ${m}`) });
    assert.equal(out.ok, true);
    assert.equal(out.created, false);
    assert.equal(out.session, `${base}-rbbb`);
    assert.equal(out.sessionId, 'r3');
    assert.match(logs[0], /\[warm-up\] harness session alexis-anatomy-harness-v4b-rbbb resumed \(r3\)/);
    assert.equal(events.length, 0, 'warm-up is silent on the SSE bus');
    // paged: ?per_page=…&page=1..N, no POST
    const pages = h.calls.filter((c) => c.url.includes('?per_page=')).map((c) => Number(new URL(c.url).searchParams.get('page')));
    assert.deepEqual(pages, [1, 2, 3, 4, 5]);
    assert.ok(!h.calls.some((c) => c.method === 'POST'));
    // the older candidates (base, r1, r2) are deleted in the background; nothing else is touched
    await p.harness.cleanup;
    const deleted = h.calls.filter((c) => c.method === 'DELETE').map((c) => c.url.split('/').pop()).sort();
    assert.deepEqual(deleted, ['base', 'r1', 'r2']);
    for (const id of ['other', 'otherCfg', 'hashVariant', 'r3']) assert.notEqual(h.state.sessions.find((s) => s.session_id === id).status, 'SESSION_STATUS_DESTROYED', id);
    const d = p.describe();
    assert.equal(d.harnessSession, `${base}-rbbb`);
    assert.equal(d.harnessSessionId, 'r3');
    assert.equal(d.harnessConfigId, CONFIG_ID);
    assert.equal(d.harnessQuestions, 0);
    assert.equal(d.harnessRotateAfter, 15);
    assert.equal(d.harnessRotateIdleMs, 20 * 60 * 1000);
    assert.equal(d.harnessRotations, 0);
    assert.equal(d.harnessRotating, false);
    assert.equal(d.harnessLastRotation, null);
    assert.equal(d.harnessLastRotationError, null);
    assert.equal(d.harnessReasoningEffort, 'off');
  } finally {
    restore();
  }
  // a single candidate: nothing deleted; none at all: a suffixed session is created from the config
  let one = fakeHarness([], { sessions: [{ session_id: 'only', name: base, status: 'SESSION_STATUS_READY', config_id: CONFIG_ID }] });
  let c = new HarnessClient(harnessConfig(CONFIG_ENV), one.impl, quiet);
  assert.deepEqual(await c.ensureSession(), { id: 'only', name: base, created: false, stale: false });
  await c.cleanup;
  assert.ok(!one.calls.some((x) => x.method === 'DELETE' || x.method === 'POST'));
  one = fakeHarness([], { sessions: [{ session_id: 'dead', name: base, status: 'SESSION_STATUS_DESTROYED', config_id: CONFIG_ID }] });
  c = new HarnessClient(harnessConfig(CONFIG_ENV), one.impl, quiet);
  const made = await c.ensureSession();
  assert.equal(made.created, true);
  assert.match(made.name, new RegExp(`^${base}-r[0-9a-z]+$`));
  assert.deepEqual(JSON.parse(one.calls.find((x) => x.method === 'POST').body), { name: made.name, config_id: CONFIG_ID });
});

test('harness: rotation after N questions creates, warms, switches between questions and deletes the old session; a question asked meanwhile is served by the old session', async () => {
  const base = 'alexis-anatomy-harness-v4b';
  const inputs = []; // [sessionId, prompt]
  const h = fakeHarness(['ANSWER: ok.'], {
    sessions: [{ session_id: 'old', name: base, status: 'SESSION_STATUS_READY', config_id: CONFIG_ID }],
    createdStatus: 'SESSION_STATUS_STARTING', // the new session is not READY until the test says so
    onInput: (text, url) => inputs.push([url.split('/').at(-2), text]),
  });
  const env = { ...CONFIG_ENV, HARNESS_TOOLS_MODE: 'none', HARNESS_ROTATE_AFTER: '2', HARNESS_ROTATE_IDLE_MS: '0' };
  const { p, restore } = setup(env, h);
  const logs = [];
  p.harness.log = { log: (m) => logs.push(m), error: (m) => logs.push(`ERR ${m}`) };
  try {
    await p.warmUp(quiet);
    assert.equal(p.harness.sessionId, 'old');
    await p.ask('q1');
    assert.equal(p.describe().harnessQuestions, 1);
    assert.equal(p.harness.rotating, null, 'no rotation yet');
    await p.ask('q2');
    // the threshold was reached: a rotation started in the background, the question did not wait for it
    assert.equal(p.describe().harnessQuestions, 2);
    assert.ok(p.harness.rotating, 'rotation in flight');
    assert.equal(p.describe().harnessRotating, true);
    assert.equal(p.harness.sessionId, 'old', 'still serving from the old session');
    const created = h.state.sessions.find((s) => s.session_id !== 'old');
    assert.ok(created, 'new session created from the config');
    assert.match(created.name, new RegExp(`^${base}-r[0-9a-z]+$`));
    assert.equal(created.config_id, CONFIG_ID);
    // a question asked while the new session is still starting is answered by the old one
    const during = await p.ask('q3');
    assert.equal(during.answer, 'ok.');
    assert.deepEqual(inputs.map(([id]) => id), ['old', 'old', 'old']);
    assert.ok(p.harness.rotating, 'rotation still in flight (new session not READY)');
    assert.equal(p.describe().harnessQuestions, 3);
    assert.ok(!h.calls.some((c) => c.method === 'DELETE'), 'old session not deleted before the switch');
    // the new session becomes READY: warm-up run, switch, delete old
    created.status = 'SESSION_STATUS_READY';
    const result = await p.harness.rotating;
    assert.deepEqual(result, { ok: true, from: base, to: created.name });
    assert.equal(p.harness.rotating, null);
    assert.equal(p.harness.sessionId, created.session_id);
    assert.equal(p.harness.sessionName, created.name);
    const warm = inputs.find(([id]) => id === created.session_id);
    assert.ok(warm, 'the new session was warmed with one run');
    assert.equal(warm[1], 'Reply with exactly: ANSWER: ready');
    assert.ok(h.calls.some((c) => c.url.endsWith(`/sessions/${created.session_id}`) && c.method === 'GET'), 'polled GET /sessions/{id} until READY');
    assert.deepEqual(h.calls.filter((c) => c.method === 'DELETE').map((c) => c.url.split('/').pop()), ['old']);
    assert.equal(h.state.sessions.find((s) => s.session_id === 'old').status, 'SESSION_STATUS_DESTROYED');
    const d = p.describe();
    assert.equal(d.harnessSession, created.name);
    assert.equal(d.harnessSessionId, created.session_id);
    assert.equal(d.harnessQuestions, 0, 'count restarts on the new session');
    assert.equal(d.harnessRotations, 1);
    assert.equal(d.harnessRotating, false);
    assert.equal(d.harnessLastRotation.from, base);
    assert.equal(d.harnessLastRotation.to, created.name);
    assert.equal(d.harnessLastRotation.deletedOld, true);
    assert.equal(d.harnessLastRotation.reason, '2 questions answered');
    assert.ok(typeof d.harnessLastRotation.at === 'number' && d.harnessLastRotation.ms >= 0);
    assert.equal(d.harnessLastRotationError, null);
    assert.ok(logs.some((m) => /rotating session alexis-anatomy-harness-v4b -> alexis-anatomy-harness-v4b-r/.test(m)));
    assert.ok(logs.some((m) => /session switched/.test(m)));
    // the next question goes to the new session
    await p.ask('q4');
    assert.equal(inputs.at(-1)[0], created.session_id);
    assert.equal(p.describe().harnessQuestions, 1);
    assert.equal(p.harness.rotating, null);
    // the manual trigger works too and reports whether it started
    const second = h.state.sessions.filter((s) => s.status !== 'SESSION_STATUS_DESTROYED').length;
    const r = p.rotateSession();
    assert.equal(r.started, true);
    assert.deepEqual(p.rotateSession(), { started: false, skipped: 'rotation already in progress' }, 'only one at a time');
    h.state.sessions.filter((s) => s.status === 'SESSION_STATUS_STARTING').forEach((s) => (s.status = 'SESSION_STATUS_READY'));
    await p.harness.rotating;
    assert.equal(h.state.sessions.filter((s) => s.status !== 'SESSION_STATUS_DESTROYED').length, second, 'one live session before and after');
    assert.equal(p.describe().harnessRotations, 2);
    assert.equal(p.describe().harnessLastRotation.reason, 'manual');
  } finally {
    restore();
  }
});

test('harness: a failed rotation warm-up deletes the new session, keeps the old one serving, records the error and backs off', async () => {
  const base = 'alexis-anatomy-harness-v4b';
  const inputs = [];
  const h = fakeHarness(['ANSWER: ok.'], {
    sessions: [{ session_id: 'old', name: base, status: 'SESSION_STATUS_READY', config_id: CONFIG_ID }],
    createdStatus: 'SESSION_STATUS_FAILED', // the new session never becomes READY
    onInput: (text, url) => inputs.push(url.split('/').at(-2)),
  });
  const { p, restore } = setup({ ...CONFIG_ENV, HARNESS_TOOLS_MODE: 'none', HARNESS_ROTATE_AFTER: '1', HARNESS_ROTATE_IDLE_MS: '0' }, h);
  p.harness.log = quiet;
  try {
    await p.warmUp(quiet);
    await p.ask('q1');
    assert.ok(p.harness.rotating);
    const result = await p.harness.rotating;
    assert.equal(result.ok, false);
    assert.match(result.error, /SESSION_STATUS_FAILED/);
    assert.equal(p.harness.sessionId, 'old', 'old session kept');
    const created = h.state.sessions.find((s) => s.session_id !== 'old');
    assert.equal(created.status, 'SESSION_STATUS_DESTROYED', 'the half-made session is deleted');
    assert.deepEqual(h.calls.filter((c) => c.method === 'DELETE').map((c) => c.url.split('/').pop()), [created.session_id]);
    const d = p.describe();
    assert.equal(d.harnessSession, base);
    assert.equal(d.harnessRotations, 0);
    assert.equal(d.harnessRotating, false);
    assert.equal(d.harnessLastRotation, null);
    assert.match(d.harnessLastRotationError.message, /SESSION_STATUS_FAILED/);
    assert.equal(d.harnessLastRotationError.from, base);
    assert.equal(d.harnessLastRotationError.to, created.name);
    assert.equal(d.harnessQuestions, 1, 'the count on the old session is kept');
    // questions keep flowing on the old session; the threshold is still exceeded but the backoff holds
    await p.ask('q2');
    assert.deepEqual(inputs, ['old', 'old']);
    assert.equal(p.harness.rotating, null, 'no retry during the backoff');
    assert.equal(h.state.sessions.length, 2, 'no second session created');
    assert.match(p.rotateSession().skipped, /backing off/);
    // the backoff is over: the next question triggers a new attempt
    p.harness.rotateBackoffUntil = 0;
    await p.ask('q3');
    assert.ok(p.harness.rotating, 'rotation retried after the backoff');
    await p.harness.rotating;
    assert.equal(h.state.sessions.length, 3);
    // a timeout while polling is a failure too
    p.harness.rotateBackoffUntil = 0;
    h.state.createdStatus = 'SESSION_STATUS_STARTING';
    p.harness.cfg.rotateReadyTimeoutMs = 5;
    await p.harness.rotate('test').promise;
    assert.match(p.describe().harnessLastRotationError.message, /not ready after 5 ms/);
    assert.equal(p.harness.sessionId, 'old');
  } finally {
    restore();
  }
});

test('harness: idle rotation triggers when the session sat unused longer than HARNESS_ROTATE_IDLE_MS before a question; 0 disables both triggers', async () => {
  const base = 'alexis-anatomy-harness-v4b';
  let h = fakeHarness(['ANSWER: ok.'], { sessions: [{ session_id: 'old', name: base, status: 'SESSION_STATUS_READY', config_id: CONFIG_ID }] });
  let { p, restore } = setup({ ...CONFIG_ENV, HARNESS_TOOLS_MODE: 'none', HARNESS_ROTATE_AFTER: '0', HARNESS_ROTATE_IDLE_MS: '1000' }, h);
  p.harness.log = quiet;
  try {
    await p.ask('q1');
    assert.equal(p.harness.rotating, null, 'first question: no idle time known yet');
    await p.ask('q2');
    assert.equal(p.harness.rotating, null, 'answered back to back');
    p.harness.lastUsedAt = Date.now() - 5000; // pretend the session sat idle
    await p.ask('q3');
    assert.ok(p.harness.rotating, 'idle threshold exceeded before q3');
    await p.harness.rotating;
    assert.equal(p.describe().harnessRotations, 1);
    assert.match(p.describe().harnessLastRotation.reason, /^idle for 5 s/);
  } finally {
    restore();
  }
  // both disabled: never rotates on its own, manual still works
  h = fakeHarness(['ANSWER: ok.'], { sessions: [{ session_id: 'old', name: base, status: 'SESSION_STATUS_READY', config_id: CONFIG_ID }] });
  ({ p, restore } = setup({ ...CONFIG_ENV, HARNESS_TOOLS_MODE: 'none', HARNESS_ROTATE_AFTER: '0', HARNESS_ROTATE_IDLE_MS: '0' }, h));
  p.harness.log = quiet;
  try {
    for (let i = 0; i < 20; i++) await p.ask(`q${i}`);
    p.harness.lastUsedAt = Date.now() - 10 ** 9;
    await p.ask('late');
    assert.equal(p.harness.rotating, null);
    assert.equal(p.describe().harnessQuestions, 21);
    assert.equal(p.rotateSession().started, true);
    await p.harness.rotating;
    assert.equal(p.describe().harnessRotations, 1);
  } finally {
    restore();
  }
  // no config id: rotation is not available
  const yaml = new HarnessClient(harnessConfig(BASE_ENV), fakeHarness([]).impl, quiet);
  assert.deepEqual(yaml.rotate().started, false);
  assert.match(yaml.rotate().skipped, /HARNESS_CONFIG_ID not set/);
});

test('harness: a session that is gone (404) is replaced by a new suffixed session from the config and the question is retried there', async () => {
  const base = 'alexis-anatomy-harness-v4b';
  const inputs = [];
  const h = fakeHarness(['ANSWER: ok.'], {
    sessions: [{ session_id: 'old', name: base, status: 'SESSION_STATUS_READY', config_id: CONFIG_ID }],
    onInput: (text, url) => {
      const id = url.split('/').at(-2);
      inputs.push(id);
      return id !== 'old'; // the old session has vanished: 404 on input
    },
  });
  const { p, events, restore } = setup({ ...CONFIG_ENV, HARNESS_TOOLS_MODE: 'none' }, h);
  p.harness.log = quiet;
  try {
    await p.warmUp(quiet);
    const out = await p.ask('q');
    assert.equal(out.answer, 'ok.');
    assert.deepEqual(inputs, ['old', 'sess-2']);
    const create = h.calls.find((c) => c.method === 'POST' && c.url.endsWith('/sessions'));
    const body = JSON.parse(create.body);
    assert.equal(body.config_id, CONFIG_ID);
    assert.match(body.name, new RegExp(`^${base}-r[0-9a-z]+$`));
    assert.equal(p.harness.sessionName, body.name);
    assert.equal(p.describe().harnessQuestions, 1);
    assert.ok(events.some((e) => e.stage === 'agent' && e.status === 'progress' && /created/.test(e.detail)));
  } finally {
    restore();
  }
});

test('harness: POST /api/harness/rotate needs the tool-event token, starts a rotation in real mode and does not exist in mock mode', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const base = 'alexis-anatomy-harness-v4b';
  // the new session stays STARTING until the test has observed the rotation in flight
  const h = fakeHarness(['ANSWER: ok.'], { sessions: [{ session_id: 'old', name: base, status: 'SESSION_STATUS_READY', config_id: CONFIG_ID }], createdStatus: 'SESSION_STATUS_STARTING' });
  const { p, restore } = setup({ ...CONFIG_ENV, HARNESS_TOOLS_MODE: 'none', MCP_AUTH_TOKEN: 'secret' }, h);
  restore(); // no MCP health check with tools mode none: the real fetch reaches the local server below
  p.harness.log = quiet;
  const recordingsDir = mkdtempSync(path.join(tmpdir(), 'anatomy-rec-'));
  const { app } = await createApp({ env: { MCP_AUTH_TOKEN: 'secret' }, pipeline: p, recordingsDir, autoCapture: false });
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}/api/harness/rotate`;
  const post = (token) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-tool-event-token': token } : {}) }, body: '{}' });
  try {
    await p.warmUp(quiet);
    assert.equal((await post()).status, 401);
    assert.equal((await post('wrong')).status, 401);
    const ok = await post('secret');
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, started: true });
    const again = await (await post('secret')).json();
    assert.deepEqual(again, { ok: true, started: false, skipped: 'rotation already in progress' });
    const health = await (await fetch(`http://127.0.0.1:${server.address().port}/api/health`)).json();
    assert.equal(health.pipeline.harnessRotating, true);
    assert.equal(health.pipeline.harnessConfigId, CONFIG_ID);
    h.state.sessions.filter((s) => s.status === 'SESSION_STATUS_STARTING').forEach((s) => (s.status = 'SESSION_STATUS_READY'));
    await p.harness.rotating;
    const after = await (await fetch(`http://127.0.0.1:${server.address().port}/api/health`)).json();
    assert.equal(after.pipeline.harnessRotating, false);
    assert.equal(after.pipeline.harnessRotations, 1);
    assert.equal(after.pipeline.harnessLastRotation.from, base);
    assert.notEqual(after.pipeline.harnessSessionId, 'old');
  } finally {
    server.close();
    restore();
  }
  // mock mode: no pipeline.rotateSession -> the route is not mounted
  const mock = await createApp({ env: { MCP_AUTH_TOKEN: 'secret', PIPELINE_MODE: 'mock', MOCK_DELAY_SCALE: '0' }, recordingsDir, autoCapture: false });
  const ms = mock.app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${ms.address().port}/api/harness/rotate`, { method: 'POST', headers: { 'x-tool-event-token': 'secret' } });
    assert.equal(res.status, 404);
  } finally {
    ms.close();
  }
});
