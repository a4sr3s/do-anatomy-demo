import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../server/bus.js';
import { RealPipeline } from '../server/pipeline/real.js';
import { MarkerFilter, HarnessClient, buildManifest, buildPrompt, buildToolPrompt, harnessConfig, manifestHash, isDontKnow } from '../server/pipeline/harness.js';

const FACT = 'Acme Robotics runs 40 GPU droplets in SFO3.';
const sseFrame = (e) => `id: x\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
const BASE_ENV = { ANSWER_BACKEND: 'harness', HARNESS_API_TOKEN: 'tok', HARNESS_INFERENCE_API_KEY: 'k', MCP_PUBLIC_URL: 'https://demo.example/mcp', MCP_AUTH_TOKEN: 'mcp-secret' };

/**
 * Fake Harness Runtime API: list -> sessions (with labels), create -> new
 * session, events -> scripted stream, input -> run id. `onInput` lets a test
 * react to the prompt (e.g. simulate the MCP server reporting tool events).
 */
function fakeHarness(deltas, { fail = false, sessions, extraEvents = [], onInput, hang = false, name = 'alexis-anatomy-harness-v4' } = {}) {
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

/** Pipeline with a stubbed pgvector, a fake harness and a routed global fetch (MCP health + agent endpoint). */
function setup(env, harness, { mcpHealthy = true, agentChunks = [] } = {}) {
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
    if (String(url).endsWith('/chat/completions')) {
      const sse = agentChunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
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

test('harness: config defaults (v4 session name, inline tools, DIGITALOCEAN_ACCESS_TOKEN fallback)', () => {
  const cfg = harnessConfig({ DIGITALOCEAN_ACCESS_TOKEN: 'dop', HARNESS_GATEWAY_TOOLS: 'anatomy-data_search_facts, anatomy-data_get_document' });
  assert.equal(cfg.token, 'dop');
  assert.equal(harnessConfig({ HARNESS_API_TOKEN: 'h', DIGITALOCEAN_ACCESS_TOKEN: 'dop' }).token, 'h');
  assert.equal(cfg.sessionName, 'alexis-anatomy-harness-v4');
  assert.equal(cfg.toolsMode, 'inline');
  assert.equal(cfg.size, 'mars-1vcpu-1gb');
  assert.equal(cfg.idleTimeout, '30m');
  assert.equal(cfg.firstTokenTimeoutMs, 45000);
  assert.deepEqual(cfg.gatewayTools, ['anatomy-data_search_facts', 'anatomy-data_get_document']);
  assert.equal(harnessConfig({ HARNESS_TOOLS_MODE: 'bogus' }).toolsMode, 'inline');
});

test('harness: inline manifest declares the anatomy-data MCP server, its secret slot and allow rules', () => {
  const m = buildManifest(harnessConfig({ ...BASE_ENV }));
  assert.match(m, /^name: alexis-anatomy-harness-v4$/m);
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

test('harness: gateway manifest selects do.actions tools with preload and allow rules, no MCP secret', () => {
  const m = buildManifest(harnessConfig({ ...BASE_ENV, HARNESS_TOOLS_MODE: 'gateway', HARNESS_GATEWAY_TOOLS: 'anatomy-data_search_facts,anatomy-data_get_document' }));
  assert.match(m, /^tools:\n  - do\.actions:\n      tools: \[anatomy-data_search_facts, anatomy-data_get_document\]\n      preload_tools: \[anatomy-data_search_facts, anatomy-data_get_document\]$/m);
  assert.match(m, /- tool: do\.actions\/anatomy-data_search_facts\n      action: allow/);
  assert.match(m, /- tool: do\.actions\/anatomy-data_get_document\n      action: allow/);
  assert.doesNotMatch(m, /ANATOMY_MCP_TOKEN/);
  assert.doesNotMatch(m, /name: anatomy-data/);
  assert.match(m, /^  tools-mode: gateway$/m);
});

test('harness: none manifest has no tools and denies everything; hash differs per mode', () => {
  const none = buildManifest(harnessConfig({ ...BASE_ENV, HARNESS_TOOLS_MODE: 'none' }));
  assert.doesNotMatch(none, /^tools:/m);
  assert.doesNotMatch(none, /ANATOMY_MCP_TOKEN/);
  assert.match(none, /permissions:\n  default: deny\n$/);
  const h = (env) => manifestHash(harnessConfig({ ...BASE_ENV, ...env }));
  assert.notEqual(h({}), h({ HARNESS_TOOLS_MODE: 'none' }));
  assert.notEqual(h({}), h({ MCP_PUBLIC_URL: 'https://other.example/mcp' }));
  assert.equal(h({}), h({ MCP_AUTH_TOKEN: 'different-secret', HARNESS_INFERENCE_API_KEY: 'other' }), 'secrets do not change the fingerprint');
});

test('harness: prompts', () => {
  const tp = buildToolPrompt('Where does Acme run?');
  assert.match(tp, /call anatomy-data\/search_facts/);
  assert.match(tp, /get_document only if/);
  assert.match(tp, /Do not use any other tool/);
  assert.match(tp, /ONLY from the tool results/);
  assert.match(tp, /do not know that yet/);
  assert.match(tp, /starts with "ANSWER:"/);
  assert.match(tp, /Question: Where does Acme run\?$/);
  assert.match(buildToolPrompt('q', { gateway: true }), /the search_facts tool/);
  assert.match(buildPrompt('q', '[1] ctx'), /do not use any tools[\s\S]*Context:\n\[1\] ctx/);
  assert.ok(isDontKnow("I don't know that yet."));
  assert.ok(isDontKnow('No relevant facts were found.'));
  assert.ok(isDontKnow(''));
  assert.ok(!isDontKnow('Acme runs 40 GPU droplets in SFO3.'));
});

test('harness: ANSWER_BACKEND selects the backend (harness is the default)', () => {
  const bus = new EventBus();
  const agentEnv = { DO_AGENT_ENDPOINT: 'https://x.agents.do-ai.run', DO_AGENT_KEY: 'k' };
  assert.equal(new RealPipeline(bus, { ...agentEnv, HARNESS_API_TOKEN: 't' }).describe().inferenceVia, 'harness');
  assert.equal(new RealPipeline(bus, { ...agentEnv, ANSWER_BACKEND: 'agent', HARNESS_API_TOKEN: 't' }).describe().inferenceVia, 'agent');
  assert.equal(new RealPipeline(bus, { ...agentEnv, ANSWER_BACKEND: 'harness' }).describe().inferenceVia, 'agent', 'no token -> agent');
  assert.equal(new RealPipeline(bus, { DIGITALOCEAN_ACCESS_TOKEN: 'dop' }).describe().inferenceVia, 'harness');
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

test('harness: "don\'t know" with zero tool results is retried once with context in the prompt', async () => {
  const prompts = [];
  let n = 0;
  const h = fakeHarness([], { onInput: (t) => prompts.push(t) });
  // first run: no tool events, don't-know answer; second run: grounded answer
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
  try {
    const out = await p.ask('How many droplets?');
    assert.equal(out.answer, '40 droplets.');
    assert.equal(out.fallback, 'context-retry');
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /search_facts/);
    assert.match(prompts[1], /Context:\n\[1\] Acme Robotics/);
    assert.ok(events.some((e) => e.stage === 'agent' && e.status === 'progress' && /retrying with context passed in prompt/.test(e.detail)));
    assert.deepEqual(starts(events), ['agent', 'inference', 'kb', 'vectordb', 'inference']);
    assert.equal(tokensOf(events), "I don't know that yet.40 droplets.", 'the first (empty-handed) answer streamed too; the UI replaces it with the final answer');
  } finally {
    restore();
  }
});

test('harness: a successful tool run with a confident answer is not retried even without tool events', async () => {
  const h = fakeHarness(['ANSWER: Acme runs 40 GPU droplets in SFO3.']);
  const { p, restore } = setup(BASE_ENV, h);
  try {
    const out = await p.ask('q');
    assert.equal(out.fallback, null);
    assert.deepEqual(out.sources, []);
  } finally {
    restore();
  }
});

test('harness: fallback 2: a run that fails before the first token goes to the Managed Agent with app-side retrieval', async () => {
  const h = fakeHarness([], { fail: true });
  const agentChunks = [{ choices: [{ delta: { content: 'From agent.' } }] }];
  const { p, events, restore } = setup({ ...BASE_ENV, DO_AGENT_ENDPOINT: 'https://x.agents.do-ai.run', DO_AGENT_KEY: 'ak' }, h, { agentChunks });
  try {
    const out = await p.ask('q');
    assert.equal(out.answer, 'From agent.');
    assert.equal(out.backend, 'agent');
    assert.equal(out.fallback, 'agent');
    assert.deepEqual(out.sources.map((s) => s.id), [7]);
    const fb = events.find((e) => e.type === 'fallback');
    assert.equal(fb.data.to, 'agent');
    assert.equal(fb.jobId, out.jobId);
    assert.ok(events.some((e) => e.stage === 'agent' && e.status === 'progress' && /falling back to Managed Agent/.test(e.detail)));
    assert.deepEqual(starts(events), ['agent', 'inference', 'kb', 'vectordb', 'agent', 'inference']);
    assert.equal(events.at(-1).data.backend, 'agent');
  } finally {
    restore();
  }
});

test('harness: first-token timeout triggers fallback 2; a mid-stream failure does not', async () => {
  const hang = fakeHarness([], { hang: true });
  const agentChunks = [{ choices: [{ delta: { content: 'From agent.' } }] }];
  const env = { ...BASE_ENV, HARNESS_FIRST_TOKEN_TIMEOUT_MS: '60', DO_AGENT_ENDPOINT: 'https://x.agents.do-ai.run', DO_AGENT_KEY: 'ak' };
  let s = setup(env, hang, { agentChunks });
  try {
    const out = await s.p.ask('q');
    assert.equal(out.backend, 'agent');
    assert.ok(s.events.some((e) => e.type === 'fallback' && /produced nothing within 60 ms/.test(e.data.reason)));
  } finally {
    s.restore();
  }
  // tokens then failure: the harness already streamed, so no agent fallback (replay fallback handles it upstream)
  const mid = fakeHarness(['ANSWER: partial'], { fail: true });
  s = setup(env, mid, { agentChunks });
  try {
    await assert.rejects(s.p.ask('q'), /Harness run failed: boom/);
    assert.ok(!s.events.some((e) => e.type === 'fallback'));
    assert.equal(s.events.at(-1).status, 'error');
  } finally {
    s.restore();
  }
});

test('harness: without a Managed Agent a pre-token failure surfaces as an error (replay fallback upstream)', async () => {
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

test('harness: tool-call events in the harness SSE stream are forwarded as tool events with source harness', async () => {
  const extraEvents = [
    { type: 'run.tool_call', data: { tool: 'anatomy-data_search_facts', input: { query: 'q' } } },
    { type: 'run.tool_result', data: { tool: 'anatomy-data_search_facts' } },
    { type: 'run.something_new', data: {} },
  ];
  const h = fakeHarness(['ANSWER: ok'], { extraEvents });
  const { p, events, restore } = setup(BASE_ENV, h);
  const debug = [];
  p.harness.log = { debug: (m) => debug.push(m) };
  try {
    await p.ask('q');
    const tool = events.filter((e) => e.type === 'tool' && e.data.source === 'harness');
    assert.deepEqual(tool.map((e) => e.data.phase), ['start', 'done']);
    assert.equal(tool[0].data.tool, 'anatomy-data_search_facts');
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
