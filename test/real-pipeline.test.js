import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../server/bus.js';
import { RealPipeline } from '../server/pipeline/real.js';

const FACT = 'Acme Robotics runs 40 GPU droplets in SFO3.';

/** Build a RealPipeline with pgvector stubbed out and a fake fetch for the LLM endpoint. */
function setup(env, { rows = [{ id: 7, chunk: FACT, score: 0.91 }], chunks = [] } = {}) {
  const bus = new EventBus();
  const events = [];
  bus.on('event', (e) => events.push(e));
  const p = new RealPipeline(bus, { DATABASE_URL: 'postgres://stub', ...env });
  p.count = rows.length;
  p.db = async () => ({ query: async () => ({ rows }) });
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { p, events, calls, restore: () => (globalThis.fetch = realFetch) };
}

const stageSeq = (events, status) => events.filter((e) => e.type === 'stage' && e.status === status).map((e) => e.stage);

test('real pipeline: describe() reports how inference is reached', () => {
  const bus = new EventBus();
  assert.equal(new RealPipeline(bus, { DO_AGENT_ENDPOINT: 'https://x.agents.do-ai.run/', DO_AGENT_KEY: 'k' }).describe().inferenceVia, 'agent');
  assert.equal(new RealPipeline(bus, { DO_INFERENCE_KEY: 'k' }).describe().inferenceVia, 'serverless');
  assert.equal(new RealPipeline(bus, {}).describe().inferenceVia, null);
});

test('real pipeline: agent path retrieves from pgvector first, streams tokens, merges agent KB sources, ignores reasoning', async () => {
  const chunks = [
    { model: 'llama3.3-70b-instruct', choices: [{ delta: { reasoning_content: 'thinking...' } }] },
    { choices: [{ delta: { content: 'Acme runs' } }] },
    { choices: [{ delta: { content: ' in SFO3.' } }], retrieval: { retrieved_data: [{ id: 'doc-1', text: 'Acme Robotics renews in March.', score: 0.5 }, { id: 'dup', text: FACT, score: 0.4 }] } },
  ];
  const { p, events, calls, restore } = setup({ DO_AGENT_ENDPOINT: 'https://x.agents.do-ai.run/', DO_AGENT_KEY: 'agent-key' }, { chunks });
  try {
    const { answer, sources } = await p.ask('Where does Acme run?');
    assert.equal(answer, 'Acme runs in SFO3.');
    // pgvector hit first, then the agent KB hit; the duplicate text is dropped
    assert.deepEqual(sources.map((s) => s.id), [7, 'doc-1']);
    assert.equal(sources[1].origin, 'agent-kb');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://x.agents.do-ai.run/api/v1/chat/completions');
    assert.equal(calls[0].init.headers.authorization, 'Bearer agent-key');
    assert.equal(calls[0].body.stream, true);
    assert.equal(calls[0].body.include_retrieval_info, true);
    assert.equal(calls[0].body.model, undefined, 'agents choose their own model');
    assert.equal(calls[0].body.messages.length, 1);
    assert.match(calls[0].body.messages[0].content, /Context:\n\[1\] Acme Robotics runs 40 GPU droplets/);
    assert.match(calls[0].body.messages[0].content, /Question: Where does Acme run\?$/);

    assert.deepEqual(stageSeq(events, 'start'), ['kb', 'vectordb', 'agent', 'inference']);
    assert.deepEqual(stageSeq(events, 'done'), ['vectordb', 'kb', 'inference', 'agent']);
    const tokens = events.filter((e) => e.type === 'stage' && e.stage === 'inference' && e.status === 'progress');
    assert.deepEqual(tokens.map((e) => e.data.token), ['Acme runs', ' in SFO3.']);
    assert.deepEqual(tokens.map((e) => e.data.index), [0, 1]);
    assert.ok(events.some((e) => e.stage === 'agent' && e.status === 'start' && e.detail === 'Managed Agent (KB + model) answering'));
    assert.ok(events.some((e) => e.stage === 'inference' && e.status === 'start' && e.detail === 'Serverless inference via agent'));
    assert.ok(events.some((e) => e.stage === 'kb' && e.status === 'progress' && e.data.step === 'agent-kb' && e.data.hits === 2));
    const ans = events.find((e) => e.type === 'answer');
    assert.equal(ans.data.text, answer);
    assert.equal(ans.data.sources.length, 2);
    assert.equal(events.at(-1).type, 'job');
    assert.equal(events.at(-1).status, 'done');
  } finally {
    restore();
  }
});

test('real pipeline: serverless path is used when only DO_INFERENCE_KEY is set', async () => {
  const chunks = [{ model: 'llama3.3-70b-instruct', choices: [{ delta: { content: 'SFO3' } }] }];
  const { p, events, calls, restore } = setup({ DO_INFERENCE_KEY: 'model-access-key', DO_INFERENCE_MODEL: 'llama3.3-70b-instruct' }, { chunks });
  try {
    const { answer, sources } = await p.ask('Where does Acme run?');
    assert.equal(answer, 'SFO3');
    assert.equal(sources.length, 1);
    assert.equal(calls[0].url, 'https://inference.do-ai.run/v1/chat/completions');
    assert.equal(calls[0].init.headers.authorization, 'Bearer model-access-key');
    assert.equal(calls[0].body.model, 'llama3.3-70b-instruct');
    assert.equal(calls[0].body.messages[0].role, 'system');
    assert.deepEqual(stageSeq(events, 'start'), ['kb', 'vectordb', 'agent', 'inference']);
  } finally {
    restore();
  }
});

test('real pipeline: no agent and no inference key is a clear error that triggers replay fallback', async () => {
  const { p, events, restore } = setup({});
  try {
    await assert.rejects(p.ask('anything'), /DO_INFERENCE_KEY missing and no DO_AGENT_ENDPOINT/);
    assert.equal(events.at(-1).type, 'job');
    assert.equal(events.at(-1).status, 'error');
    assert.equal(stageSeq(events, 'start').length, 0, 'fails before touching the database');
  } finally {
    restore();
  }
});
