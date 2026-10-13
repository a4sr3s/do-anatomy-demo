/**
 * DigitalOcean Harness Runtime client (Managed Agents, public preview).
 *
 * The question step runs inside a long-lived Harness Runtime session: an
 * OpenCode harness in a hardware-isolated microVM whose model is served by
 * DigitalOcean Serverless Inference. The app keeps ONE named session warm-ish
 * (it auto-pauses when idle; sending input resumes it), sends each prompt
 * with POST /v2/agents/sessions/{id}/input and streams the answer from the
 * session's SSE event stream (GET /v2/agents/sessions/{id}/events,
 * `run.token_delta` events) back into the demo's own SSE bus.
 *
 * Architecture v4: the session is created with tools. In `inline` mode the
 * manifest declares our own "anatomy-data" MCP server (mcp/) directly; in
 * `gateway` mode it selects the same tools from the Action Gateway catalog
 * (`do.actions`) after the MCP server was registered there as a custom
 * provider; `none` means no tools (context is passed in the prompt).
 *
 * API surface (godo HostedAgentsService, doctl `harness-runtime`):
 *   POST /v2/agents/sessions            body = YAML manifest (application/x-yaml)
 *   GET  /v2/agents/sessions?name=...   look up our session
 *   POST /v2/agents/sessions/{id}/input {"text": "..."} -> {"run_id"}
 *   GET  /v2/agents/sessions/{id}/events  text/event-stream (run.started,
 *        run.token_delta {text,is_reasoning}, run.usage_recorded, run.completed, run.failed,
 *        plus tool-call events whose exact names are forwarded as-is)
 */
import { createHash } from 'node:crypto';
import { DONT_KNOW_TEXT } from './retrieval.js';

export { DONT_KNOW_TEXT };

const API = 'https://api.digitalocean.com/v2/agents/sessions';
const MARKER = 'ANSWER:';
/** Shared by both prompts: the session is long-lived, so earlier turns can describe facts that no longer exist. */
const STALE_TURNS = 'Facts can be added or deleted at any time, so everything from earlier turns is stale and must never be used.';
export const MCP_SERVER_NAME = 'anatomy-data';
export const MCP_TOOLS = ['search_facts', 'get_document'];
export const MCP_SECRET_SLOT = 'ANATOMY_MCP_TOKEN';
export const TOOLS_MODES = ['inline', 'gateway', 'none'];
/** Action Gateway slugs are `<serverRef>_<tool>`; the MCP server is registered as `anatomy-data`. */
export const DEFAULT_GATEWAY_TOOLS = MCP_TOOLS.map((t) => `${MCP_SERVER_NAME}_${t}`);

/**
 * Bare MCP tool name from however the harness spells it: `do_actions_anatomy-data_search_facts`,
 * `do.actions/anatomy-data/get_document`, `anatomy-data_search_facts`, … -> `search_facts`.
 * Returns '' for falsy input or a run-event type (`run.tool_call_completed`) that carries no tool name.
 */
export function normalizeToolName(name) {
  let n = String(name || '').trim();
  if (!n || /^run\./.test(n)) return '';
  let prev;
  do {
    prev = n;
    n = n.replace(/^(do[._-]actions|do)[._/-]+/i, '').replace(new RegExp(`^${MCP_SERVER_NAME}[._/-]+`, 'i'), '');
  } while (n !== prev);
  return n;
}

/** Target the tool reaches: `search_facts` -> pgvector, `get_document` -> Spaces, anything else -> null. */
export function toolTarget(name) {
  const n = normalizeToolName(name);
  return n === 'get_document' ? 'spaces' : n === 'search_facts' ? 'pgvector' : null;
}

export function harnessConfig(env) {
  const toolsMode = (env.HARNESS_TOOLS_MODE || 'gateway').toLowerCase();
  const gatewayTools = String(env.HARNESS_GATEWAY_TOOLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    token: env.HARNESS_API_TOKEN || env.DIGITALOCEAN_ACCESS_TOKEN || '',
    inferenceKey: env.HARNESS_INFERENCE_API_KEY || '',
    sessionName: env.HARNESS_SESSION_NAME || 'alexis-anatomy-harness-v4',
    model: env.HARNESS_MODEL || 'openai-gpt-oss-20b',
    size: env.HARNESS_SIZE || 'mars-1vcpu-1gb',
    idleTimeout: env.HARNESS_IDLE_TIMEOUT || '30m',
    timeoutMs: Number(env.HARNESS_TIMEOUT_MS) || 90000,
    firstTokenTimeoutMs: Number(env.HARNESS_FIRST_TOKEN_TIMEOUT_MS) || 45000,
    apiUrl: (env.HARNESS_API_URL || API).replace(/\/$/, ''),
    toolsMode: TOOLS_MODES.includes(toolsMode) ? toolsMode : 'gateway',
    mcpUrl: (env.MCP_PUBLIC_URL || '').replace(/\/$/, ''),
    mcpToken: env.MCP_AUTH_TOKEN || '',
    gatewayTools: gatewayTools.length ? gatewayTools : DEFAULT_GATEWAY_TOOLS,
  };
}

/** The non-secret parts of the manifest that decide whether an existing session is reusable. */
export function manifestParts(cfg) {
  const parts = { agent: 'opencode', size: cfg.size, idleTimeout: cfg.idleTimeout, model: cfg.model, toolsMode: cfg.toolsMode };
  if (cfg.toolsMode === 'inline') Object.assign(parts, { mcpUrl: cfg.mcpUrl, mcpTools: MCP_TOOLS });
  if (cfg.toolsMode === 'gateway') parts.gatewayTools = cfg.gatewayTools;
  return parts;
}

/** Short fingerprint of the non-secret manifest, stored in the session labels. */
export function manifestHash(cfg) {
  return createHash('sha1').update(JSON.stringify(manifestParts(cfg))).digest('hex').slice(0, 8);
}

/** YAML manifest for the session. Secrets are resolved here and never stored in the repo. */
export function buildManifest(cfg, name = cfg.sessionName) {
  const q = (s) => JSON.stringify(String(s));
  const lines = [
    `name: ${name}`,
    'agent: opencode',
    `size: ${cfg.size}`,
    `idle_timeout: ${cfg.idleTimeout}`,
    'description: "do-anatomy-demo question step (v4: grounded answers through the anatomy-data MCP tools)"',
    'labels:',
    '  app: do-anatomy-demo',
    '  owner: alexis',
    `  manifest: ${manifestHash(cfg)}`,
    `  tools-mode: ${cfg.toolsMode}`,
    'env:',
    `  HARNESS_INFERENCE_MODEL: ${q(cfg.model)}`,
    'secrets:',
    `  HARNESS_INFERENCE_API_KEY: ${q(cfg.inferenceKey)}`,
  ];
  if (cfg.toolsMode === 'inline') {
    // auth.secret names a secret slot declared above; the harness sends its value in the
    // auth.header (defaults to Authorization). The MCP server accepts "Bearer <token>" and the raw token.
    lines.push(`  ${MCP_SECRET_SLOT}: ${q(`Bearer ${cfg.mcpToken}`)}`);
    lines.push(
      'tools:',
      `  - name: ${MCP_SERVER_NAME}`,
      `    url: ${q(cfg.mcpUrl)}`,
      `    tools: [${MCP_TOOLS.join(', ')}]`,
      '    auth:',
      '      header: Authorization',
      `      secret: ${MCP_SECRET_SLOT}`,
      'permissions:',
      '  default: deny',
      '  rules:'
    );
    for (const t of MCP_TOOLS) lines.push(`    - tool: ${MCP_SERVER_NAME}/${t}`, '      action: allow');
  } else if (cfg.toolsMode === 'gateway') {
    const list = cfg.gatewayTools;
    lines.push('tools:', '  - do.actions:', `      tools: [${list.join(', ')}]`, `      preload_tools: [${list.join(', ')}]`, 'permissions:', '  default: deny', '  rules:');
    for (const t of list) lines.push(`    - tool: do.actions/${t}`, '      action: allow');
  } else {
    // The harness only needs to write text: no shell, file or web tools.
    lines.push('permissions:', '  default: deny');
  }
  lines.push('');
  return lines.join('\n');
}

/** Context-in-prompt (fallback 1 / tools mode none / the single run after the app-side guard search). */
export function buildPrompt(question, context) {
  return [
    'You are the answering step of a retrieval pipeline. Ignore all earlier turns in this conversation and do not use any tools.',
    `${STALE_TURNS} The context below is the only source of truth for this turn.`,
    `Answer the question using ONLY the context below. If the context is empty or does not contain the answer, reply exactly "${MARKER} ${DONT_KNOW_TEXT}" (say that you do not know that yet).`,
    `Reply with a single line that starts with "${MARKER}" followed by a concise answer (one or two sentences).`,
    '',
    'Context:',
    context || '(none)',
    '',
    `Question: ${question}`,
  ].join('\n');
}

/**
 * Tool path (v4): the agent retrieves through the MCP tools itself. Exactly one
 * search_facts call per turn; a NO_MATCHING_FACTS result ends the turn at once
 * (the MCP server returns it when nothing clears the relevance floor) so
 * questions about unknown facts do not pay for a second search or more reasoning.
 */
export function buildToolPrompt(question, { gateway = false } = {}) {
  const search = gateway ? 'the search_facts tool' : `${MCP_SERVER_NAME}/search_facts`;
  const doc = gateway ? 'get_document' : `${MCP_SERVER_NAME}/get_document`;
  return [
    'You are the answering step of a retrieval pipeline. Ignore all earlier turns in this conversation.',
    `${STALE_TURNS} Never answer from memory or from an earlier turn, even if the same question was asked before.`,
    `You MUST call ${search} in this turn, exactly once, with the question below as the query (k=3), before answering. Never call it a second time, with any query. Call ${doc} only if a hit is truncated and you need its full text.`,
    'Do not use any other tool, do not run commands, do not read or write files, do not browse.',
    `If the search result starts with "NO_MATCHING_FACTS", immediately reply with the single line "${MARKER} ${DONT_KNOW_TEXT}" and nothing else: no further tool calls, no reasoning, no rephrased search.`,
    `Otherwise answer ONLY from this turn's tool results. If they do not contain the answer, reply with that same line: "${MARKER} ${DONT_KNOW_TEXT}".`,
    `After the tool call, reply with a single final line that starts with "${MARKER}" followed by a concise answer (one or two sentences).`,
    '',
    `Question: ${question}`,
  ].join('\n');
}

/** Heuristic for a "no answer" reply, used to decide whether a run whose tool call failed is retried with context in the prompt. */
export function isDontKnow(text) {
  return !String(text || '').trim() || /\b(don'?t|do not|does not|doesn'?t|did not|not) (know|have|find|contain)|no (relevant )?(information|facts?|results?|context)|couldn'?t find|cannot find|unable to find|nothing relevant|not (yet )?(available|known)/i.test(text);
}

/**
 * Splits streamed text at the ANSWER: marker so any visible "thinking" the
 * model emits before it (gpt-oss does) is not streamed to the audience.
 *
 * The answer is one line. gpt-oss sometimes keeps "thinking" in plain text
 * after a first ANSWER: line (often glued on without a space, e.g.
 * "...yet.We must search again"), calls another tool and writes a second
 * ANSWER: line. So streaming stops at the end of the first answer line: a
 * newline, a sentence end glued to a capital letter, or a tool call (close()).
 * The final text is the last ANSWER: segment, cut the same way; the `answer`
 * event carries it and replaces whatever was streamed.
 */
const GLUED_SENTENCE = /[a-z0-9)\]"'’][.!?](?=[A-Z])/;

function firstAnswerLine(text) {
  const t = String(text || '').replace(/^\s+/, '');
  let end = t.length;
  const nl = t.search(/\r?\n/);
  if (nl !== -1) end = nl;
  const glued = GLUED_SENTENCE.exec(t.slice(0, end));
  if (glued) end = glued.index + 2;
  return { text: t.slice(0, end), complete: end < t.length };
}

export class MarkerFilter {
  constructor(onToken) {
    this.onToken = onToken;
    this.raw = '';
    this.found = false;
    this.closed = false;
    this.emitted = '';
    this.i = 0;
  }
  push(text) {
    this.raw += text;
    if (this.closed) return;
    if (!this.found) {
      const at = this.raw.lastIndexOf(MARKER);
      if (at === -1) return;
      this.found = true;
      this.start = at + MARKER.length;
    }
    const seg = this.raw.slice(this.start);
    const next = seg.indexOf(MARKER);
    const line = firstAnswerLine(next === -1 ? seg : seg.slice(0, next));
    const out = line.text.slice(this.emitted.length);
    if (out) { this.emitted += out; this.onToken(out, this.i++); }
    if (line.complete || next !== -1) this.closed = true;
  }
  /** The model moved on (e.g. another tool call): stop streaming the current answer line. */
  close() {
    if (this.found && this.emitted) this.closed = true;
  }
  /** Final answer: the last ANSWER: segment; if the model never used the marker, the whole text. */
  finish() {
    if (!this.found) {
      const t = this.raw.trim();
      if (t) this.onToken(t, this.i++);
      return { text: t, tokens: this.i };
    }
    const at = this.raw.lastIndexOf(MARKER);
    const last = firstAnswerLine(this.raw.slice(at + MARKER.length)).text.trim();
    return { text: last || this.emitted.trim(), tokens: this.i };
  }
}

const KNOWN_EVENTS = new Set(['run.started', 'run.token_delta', 'run.usage_recorded', 'run.completed', 'run.failed', 'run.log']);
const isToolEventType = (type) => /tool/i.test(type || '');

export class HarnessClient {
  constructor(cfg, fetchImpl = (...a) => fetch(...a), log = console) {
    this.cfg = cfg;
    this.fetch = fetchImpl;
    this.log = log;
    this.sessionId = null;
    this.sessionName = null;
    this.queue = Promise.resolve(); // one run at a time per session
    this.seenEventTypes = new Set();
  }

  headers(extra = {}) {
    return { authorization: `Bearer ${this.cfg.token}`, accept: 'application/json', ...extra };
  }

  get hash() {
    return manifestHash(this.cfg);
  }

  async listByName(name) {
    const res = await this.fetch(`${this.cfg.apiUrl}?name=${encodeURIComponent(name)}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Harness list sessions failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    return (json.sessions || []).filter((s) => s.name === name && !/DESTROY|FAILED/.test(s.status || ''));
  }

  /**
   * Find a reusable session: the base name if its manifest label matches the
   * current fingerprint, else `<name>-<hash>`. Stale sessions are never deleted.
   */
  async findSession() {
    const [base] = await this.listByName(this.cfg.sessionName);
    // The sessions API (list and get) does not return labels, so a missing label cannot prove the
    // base is stale: trust the name then. Only a label that is present and differs means stale.
    const label = base?.labels?.manifest;
    if (base && (label == null || label === this.hash)) return { session: base, name: this.cfg.sessionName, stale: false };
    const alt = `${this.cfg.sessionName}-${this.hash}`;
    // the sessions API does not return labels, so a variant named after the current hash is
    // looked up even when the base is gone (else deleting an unused base session would make
    // the next boot create a fresh base instead of reusing the variant)
    const [variant] = await this.listByName(alt);
    if (variant) return { session: variant, name: alt, stale: Boolean(base) };
    return { session: null, name: base ? alt : this.cfg.sessionName, stale: Boolean(base) };
  }

  async createSession(name) {
    if (!this.cfg.inferenceKey) throw new Error('HARNESS_INFERENCE_API_KEY missing');
    if (this.cfg.toolsMode === 'inline' && !this.cfg.mcpUrl) throw new Error('MCP_PUBLIC_URL missing (required with HARNESS_TOOLS_MODE=inline)');
    if (this.cfg.toolsMode === 'inline' && !this.cfg.mcpToken) throw new Error('MCP_AUTH_TOKEN missing (required with HARNESS_TOOLS_MODE=inline)');
    const res = await this.fetch(this.cfg.apiUrl, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/x-yaml' }),
      body: buildManifest(this.cfg, name),
    });
    if (!res.ok) throw new Error(`Harness create session failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    return json.session || json;
  }

  /** Returns { id, name, created, stale } for the session, creating it on first use. */
  async ensureSession(force = false) {
    if (this.sessionId && !force) return { id: this.sessionId, name: this.sessionName, created: false, stale: false };
    const found = force ? { session: null, name: this.sessionName || this.cfg.sessionName, stale: false } : await this.findSession();
    let s = found.session;
    let created = false;
    if (!s) { s = await this.createSession(found.name); created = true; }
    this.sessionId = s.session_id;
    this.sessionName = found.name;
    return { id: this.sessionId, name: found.name, created, stale: found.stale };
  }

  ask(prompt, hooks = {}) {
    const run = this.queue.then(() => this._ask(prompt, hooks, true));
    this.queue = run.catch(() => {});
    return run;
  }

  async _ask(prompt, hooks, retry) {
    if (!this.cfg.token) throw new Error('HARNESS_API_TOKEN missing');
    const t0 = Date.now();
    let session;
    try {
      session = await this.ensureSession();
    } catch (err) {
      throw Object.assign(err, { beforeFirstToken: true });
    }
    hooks.onSession?.({ ...session, toolsMode: this.cfg.toolsMode, hash: this.hash });
    try {
      return await this._run(session.id, prompt, hooks, t0);
    } catch (err) {
      if (retry && err.recoverable) {
        this.sessionId = null;
        const fresh = await this.ensureSession(err.status === 404);
        hooks.onSession?.({ ...fresh, retried: true, toolsMode: this.cfg.toolsMode, hash: this.hash });
        return this._run(fresh.id, prompt, hooks, t0);
      }
      throw err;
    }
  }

  async _run(id, prompt, hooks, t0) {
    const ac = new AbortController();
    const fail = (message, extra = {}) => Object.assign(new Error(message), extra);
    const timer = setTimeout(() => ac.abort(fail(`Harness run timed out after ${this.cfg.timeoutMs} ms`, { timeout: true })), this.cfg.timeoutMs);
    // liveness guard: nothing at all (no token, no tool activity) within the first-token window fails the run (server/app.js may then replay a recording)
    let firstTimer = setTimeout(() => ac.abort(fail(`Harness produced nothing within ${this.cfg.firstTokenTimeoutMs} ms`, { timeout: true, beforeFirstToken: true })), this.cfg.firstTokenTimeoutMs);
    const alive = () => {
      if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
    };
    const stats = { firstTokenMs: null, model: null, tokensIn: 0, tokensOut: 0, harnessToolEvents: 0 };
    // "first token" = first answer token streamed to the audience (text after ANSWER:); hidden
    // reasoning and tool activity only count as liveness for the first-token timeout.
    let sawOutput = false;
    const filter = new MarkerFilter((tok, i) => {
      if (stats.firstTokenMs == null) stats.firstTokenMs = Date.now() - t0;
      sawOutput = true;
      hooks.onToken?.(tok, i);
    });
    try {
      const sse = await this.fetch(`${this.cfg.apiUrl}/${id}/events`, {
        headers: this.headers({ accept: 'text/event-stream', 'cache-control': 'no-cache' }),
        signal: ac.signal,
      });
      if (!sse.ok) throw fail(`Harness events failed: ${sse.status}`, { recoverable: sse.status === 404, status: sse.status, beforeFirstToken: true });
      const res = await this.fetch(`${this.cfg.apiUrl}/${id}/input`, {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ text: prompt }),
        signal: ac.signal,
      });
      if (!res.ok) {
        const body = await res.text();
        throw fail(`Harness input failed: ${res.status} ${body}`, { recoverable: [404, 409, 410].includes(res.status), status: res.status, beforeFirstToken: true });
      }
      const { run_id: runId } = await res.json();
      hooks.onRun?.({ runId, sessionId: id });

      const reader = sse.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw fail('Harness event stream ended before the run completed', { beforeFirstToken: !sawOutput });
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
          if (!data) continue;
          let e;
          try { e = JSON.parse(data); } catch { continue; }
          if (e.run_id !== runId) continue;
          const d = e.data || {};
          if (e.type === 'run.started') hooks.onStarted?.(Date.now() - t0);
          else if (e.type === 'run.token_delta') {
            alive();
            if (!d.is_reasoning && typeof d.text === 'string') filter.push(d.text);
          } else if (e.type === 'run.usage_recorded') stats.model = d.model_id || stats.model;
          else if (e.type === 'run.failed') throw fail(`Harness run failed: ${d.message || 'unknown error'}`, { beforeFirstToken: !sawOutput });
          else if (e.type === 'run.completed') {
            stats.tokensIn = d.total_tokens_in || 0;
            stats.tokensOut = d.total_tokens_out || 0;
            reader.cancel().catch(() => {});
            const out = filter.finish();
            if (stats.firstTokenMs == null && out.text) stats.firstTokenMs = Date.now() - t0;
            return { ...out, ...stats, totalMs: Date.now() - t0, runId, sessionId: id };
          } else if (isToolEventType(e.type)) {
            // tool-call events from the harness itself (names vary by adapter); the MCP server's own events are primary
            alive();
            stats.harnessToolEvents++;
            filter.close();
            hooks.onToolEvent?.({ type: e.type, data: d, ts: e.ts || Date.now() });
          } else if (!KNOWN_EVENTS.has(e.type) && !this.seenEventTypes.has(e.type)) {
            this.seenEventTypes.add(e.type);
            this.log.debug?.(`[harness] unhandled event type ${e.type}`);
          }
        }
      }
    } catch (err) {
      if (ac.signal.aborted && ac.signal.reason) throw ac.signal.reason;
      if (err.beforeFirstToken === undefined) err.beforeFirstToken = !sawOutput;
      throw err;
    } finally {
      clearTimeout(timer);
      alive();
      ac.abort();
    }
  }
}
