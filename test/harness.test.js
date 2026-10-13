import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../server/bus.js';
import { RealPipeline } from '../server/pipeline/real.js';
import { MarkerFilter, HarnessClient, buildManifest, buildPrompt, buildToolPrompt, harnessConfig, manifestHash, isDontKnow, normalizeToolName, toolTarget, DONT_KNOW_TEXT } from '../server/pipeline/harness.js';

const FACT = 'Acme Robotics runs 40 GPU droplets in SFO3.';
const sseFrame = (e) => `id: x\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
const BASE_ENV = { HARNESS_API_TOKEN: 'tok', HARNESS_INFERENCE_API_KEY: 'k', MCP_PUBLIC_URL: 'https://demo.example/mcp', MCP_AUTH_TOKEN: 'mcp-secret' };

/**
 * Fake Harness Runtime API: list -> sessions (with labels), create -> new
 * session, events -> scripted stream, input -> run id. `onInput` lets a test
 * react to the prompt (e.g. simulate the MCP server reporting tool events).
 */
function fakeHarness(deltas, { fail = false, sessions, extraEvents = [], onInput, hang = false, name = 'alexis-anatomy-harness-v5' } = {}) {
  const calls = [];
  const runId = 'run-1';
  const state = { sessions: sessions || [{ session_id: 'sess-1', name, status: 'SESSION_STATUS_PAUSED', labels: { manifest: '__match__' } }] };
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body });
    const u = String(url);
    if (u.includes('?name=')) {
      const want = decodeURIComponent(u.split('?name=')[1]);
      return Response.json({ sessions: state.sessions.filter((s) => s.name === want) });
    }
    if (init.method === 'POST' && u.endsWith('/sessions')) {
      const created = { session_id: `sess-${state.sessions.length + 1}`, name: /^name: (.*)$/m.exec(init.body)[1], status: 'SESSION_STATUS_RUNNING' };
      state.sessions.push(created);
      return Response.json({ session: created });
    }
    if (u.endsWith('/input')) {
      onInput?.(JSON.parse(init.body).text);
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
        { type: 'run.usage_recorded', run_id: runId, data: { model_id: 'openai-gpt-oss-20b' } },
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

test('harness: MarkerFilter hides text before ANSWER: and falls back to raw text', () => {
  const out = [];
  const f = new MarkerFilter((t) => out.push(t));
  ['We need to', ' answer. ANS', 'WER:', ' 40', ' droplets.'].forEach((t) => f.push(t));
  assert.equal(out.join(''), '40 droplets.');
  assert.equal(f.finish().text, '40 droplets.');
  const g = new MarkerFilter(() => {});
  g.push('plain answer ');
  assert.equal(g.finish().text, 'plain answer');
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
  assert.equal(cfg.sessionName, 'alexis-anatomy-harness-v5');
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
});

test('harness: inline manifest declares the anatomy-data MCP server, its secret slot and allow rules', () => {
  const m = buildManifest(harnessConfig({ ...BASE_ENV, HARNESS_TOOLS_MODE: 'inline' }));
  assert.match(m, /^name: alexis-anatomy-harness-v5$/m);
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
  assert.equal(d.harnessSession, 'alexis-anatomy-harness-v5');
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
    assert.equal(out.session, 'alexis-anatomy-harness-v5');
    assert.equal(out.sessionId, 'sess-1');
    assert.equal(events.length, 0, 'warm-up is silent on the SSE bus');
    assert.match(logs[0], /\[warm-up\] harness session alexis-anatomy-harness-v5 resumed \(sess-1\)/);
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
