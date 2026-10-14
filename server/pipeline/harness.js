/**
 * DigitalOcean Harness Runtime client (Managed Agents, public preview).
 *
 * The question step runs inside a long-lived Harness Runtime session: an
 * OpenCode harness in a hardware-isolated microVM whose model is served by
 * DigitalOcean Serverless Inference. The app keeps ONE named session warm-ish
 * (it auto-pauses when idle; sending input resumes it), sends each prompt
 * with POST /v2/agents/sessions/{id}/input and streams the answer from the
 * session's SSE event stream (GET /v2/agents/sessions/{id}/events,
 * `run.token_delta` events) back into the demo's own SSE bus. The event stream
 * is attached ONCE per session and kept open across questions (SessionStream):
 * events are routed to the run that owns them by run_id, and the stream is only
 * re-attached (with Last-Event-ID) when it actually drops. POST /input never
 * waits for an attach.
 *
 * Architecture v4: the session is created with tools. In `inline` mode the
 * manifest declares our own "anatomy-data" MCP server (mcp/) directly; in
 * `gateway` mode it selects the same tools from the Action Gateway catalog
 * (`do.actions`) after the MCP server was registered there as a custom
 * provider; `none` means no tools (context is passed in the prompt).
 *
 * Session hygiene: with HARNESS_CONFIG_ID the session is created from an immutable
 * Environment Config (JSON create, no new config persisted) and rotated in the
 * background after HARNESS_ROTATE_AFTER questions or HARNESS_ROTATE_IDLE_MS of
 * idleness (`<base>-r<ts>` names; see rotate()). Reasoning effort has no API
 * parameter, so the gpt-oss Harmony line `Reasoning: low` leads every prompt.
 *
 * API surface (godo HostedAgentsService, doctl `harness-runtime`):
 *   POST /v2/agents/sessions            body = {"name","config_id"} (application/json)
 *                                       or a YAML manifest (application/x-yaml, no config id)
 *   GET  /v2/agents/sessions?name=...   look up our session (also ?per_page=&page= to page through all)
 *   GET  /v2/agents/sessions/{id}       status (SESSION_STATUS_READY / _PAUSED / _DESTROYED / _FAILED)
 *   DELETE /v2/agents/sessions/{id}     destroy a session
 *   POST /v2/agents/sessions/{id}/input {"text": "..."} -> {"run_id"}
 *   GET  /v2/agents/sessions/{id}/events  text/event-stream (run.started,
 *        run.token_delta {text,is_reasoning}, run.usage_recorded, run.completed, run.failed,
 *        plus tool-call events whose exact names are forwarded as-is)
 */
import { createHash, randomUUID } from 'node:crypto';
import { DONT_KNOW_TEXT, DONT_KNOW_TEXT_ES, dontKnowText, looksSpanish } from './retrieval.js';

export { DONT_KNOW_TEXT, DONT_KNOW_TEXT_ES, dontKnowText, looksSpanish };

const API = 'https://api.digitalocean.com/v2/agents/sessions';
const MARKER = 'ANSWER:';
/** Shared by both prompts: the session is long-lived, so earlier turns can describe facts that no longer exist. */
const STALE_TURNS = 'Facts can be added or deleted at any time, so everything from earlier turns is stale and must never be used.';
/**
 * Shared by both prompts: the audience may ask in Spanish (or any language). The
 * answer follows the question's language; the fixed "don't know" line is
 * localised the same way, but the ANSWER: marker never changes.
 */
const LANGUAGE_RULE = `Write the answer in the same language as the question (an English question gets an English answer, a Spanish question a Spanish answer, and so on); the "don't know" line is translated the same way (English "${DONT_KNOW_TEXT}", Spanish "${DONT_KNOW_TEXT_ES}") but always starts with "${MARKER}".`;
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

/** The immutable Environment Config the live session alexis-anatomy-harness-v4b was created from. */
export const DEFAULT_CONFIG_ID = '01a132ee-ff11-7130-9d05-838874ecec77';
export const REASONING_EFFORTS = ['low', 'medium', 'high', 'off'];
const DEFAULT_ROTATE_AFTER = 15;
const DEFAULT_ROTATE_IDLE_MS = 20 * 60 * 1000;

/** Integer env value with a default for unset/blank/invalid; `0` is a valid "disabled". */
function intEnv(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function harnessConfig(env) {
  const toolsMode = (env.HARNESS_TOOLS_MODE || 'gateway').toLowerCase();
  const gatewayTools = String(env.HARNESS_GATEWAY_TOOLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const effort = String(env.HARNESS_REASONING_EFFORT || 'off').trim().toLowerCase();
  // HARNESS_CONFIG_ID unset -> the default config; `none` or blank -> no config (YAML manifest path)
  const rawConfig = env.HARNESS_CONFIG_ID === undefined ? DEFAULT_CONFIG_ID : String(env.HARNESS_CONFIG_ID).trim();
  return {
    token: env.HARNESS_API_TOKEN || env.DIGITALOCEAN_ACCESS_TOKEN || '',
    inferenceKey: env.HARNESS_INFERENCE_API_KEY || '',
    sessionName: env.HARNESS_SESSION_NAME || 'alexis-anatomy-harness-v4b',
    model: env.HARNESS_MODEL || 'openai-gpt-oss-20b',
    size: env.HARNESS_SIZE || 'mars-1vcpu-1gb',
    idleTimeout: env.HARNESS_IDLE_TIMEOUT || '30m',
    timeoutMs: Number(env.HARNESS_TIMEOUT_MS) || 90000,
    // liveness window: with the event stream already attached, nothing within 15 s is a real failure
    // (server/app.js then replays a recording); the old 45 s only made the audience wait for the replay
    firstTokenTimeoutMs: Number(env.HARNESS_FIRST_TOKEN_TIMEOUT_MS) || 15000,
    // persistent event stream: attach (response headers) timeout and the silence after which a stream is re-attached
    attachTimeoutMs: intEnv(env.HARNESS_ATTACH_TIMEOUT_MS, 20000),
    streamIdleMs: intEnv(env.HARNESS_STREAM_IDLE_MS, 60000),
    streamBackoffMs: 500, // first re-attach delay after a drop (doubles up to 10 s); not an env knob
    apiUrl: (env.HARNESS_API_URL || API).replace(/\/$/, ''),
    toolsMode: TOOLS_MODES.includes(toolsMode) ? toolsMode : 'gateway',
    mcpUrl: (env.MCP_PUBLIC_URL || '').replace(/\/$/, ''),
    mcpToken: env.MCP_AUTH_TOKEN || '',
    gatewayTools: gatewayTools.length ? gatewayTools : DEFAULT_GATEWAY_TOOLS,
    // gpt-oss Harmony reasoning effort, sent as the first prompt line (there is no API parameter); `off` sends nothing
    reasoningEffort: REASONING_EFFORTS.includes(effort) ? effort : 'off',
    // session hygiene: sessions are created from this Environment Config (JSON create) and rotated
    configId: /^none$/i.test(rawConfig) ? '' : rawConfig,
    rotateAfter: intEnv(env.HARNESS_ROTATE_AFTER, DEFAULT_ROTATE_AFTER),
    rotateIdleMs: intEnv(env.HARNESS_ROTATE_IDLE_MS, DEFAULT_ROTATE_IDLE_MS),
    rotateReadyTimeoutMs: intEnv(env.HARNESS_ROTATE_READY_TIMEOUT_MS, 120000),
    rotatePollMs: intEnv(env.HARNESS_ROTATE_POLL_MS, 2000),
    rotateBackoffMs: intEnv(env.HARNESS_ROTATE_BACKOFF_MS, 5 * 60 * 1000),
  };
}

/** First prompt line for gpt-oss: `Reasoning: low` (Harmony convention); nothing for `off` / empty. */
export function reasoningLine(effort) {
  const e = String(effort || '').trim().toLowerCase();
  return e && e !== 'off' ? `Reasoning: ${e}` : '';
}

/** Prepend the reasoning line (when any) to the prompt lines. */
function withReasoning(lines, effort) {
  const line = reasoningLine(effort);
  return line ? [line, ...lines] : lines;
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
export function buildPrompt(question, context, { effort = '' } = {}) {
  const dk = dontKnowText(question);
  return withReasoning([
    'You are the answering step of a retrieval pipeline. Ignore all earlier turns in this conversation and do not use any tools.',
    `${STALE_TURNS} The context below is the only source of truth for this turn.`,
    `Answer the question using ONLY the context below. If the context is empty or does not contain the answer, reply exactly "${MARKER} ${dk}" (say that you do not know that yet).`,
    `Reply with a single line that starts with "${MARKER}" followed by a concise answer (one or two sentences).`,
    LANGUAGE_RULE,
    '',
    'Context:',
    context || '(none)',
    '',
    `Question: ${question}`,
  ], effort).join('\n');
}

/**
 * Tool path (v4): the agent retrieves through the MCP tools itself. Exactly one
 * search_facts call per turn; a NO_MATCHING_FACTS result ends the turn at once
 * (the MCP server returns it when nothing clears the relevance floor) so
 * questions about unknown facts do not pay for a second search or more reasoning.
 */
export function buildToolPrompt(question, { gateway = false, effort = '' } = {}) {
  const search = gateway ? 'the search_facts tool' : `${MCP_SERVER_NAME}/search_facts`;
  const doc = gateway ? 'get_document' : `${MCP_SERVER_NAME}/get_document`;
  const dk = dontKnowText(question);
  return withReasoning([
    'You are the answering step of a retrieval pipeline. Ignore all earlier turns in this conversation.',
    `${STALE_TURNS} Never answer from memory or from an earlier turn, even if the same question was asked before.`,
    `You MUST call ${search} in this turn, exactly once, with the question below as the query (k=3), before answering. Pass the question as \`query\` exactly as the user wrote it, in its own language: never translate, rephrase or shorten it (the embedder is multilingual). Never call it a second time, with any query. Call ${doc} only if a hit is truncated and you need its full text.`,
    'Do not use any other tool, do not run commands, do not read or write files, do not browse.',
    `If the search result starts with "NO_MATCHING_FACTS", immediately reply with the single line "${MARKER} ${dk}" and nothing else: no further tool calls, no reasoning, no rephrased search.`,
    `Otherwise answer ONLY from this turn's tool results. If they do not contain the answer, reply with that same line: "${MARKER} ${dk}".`,
    `After the tool call, reply with a single final line that starts with "${MARKER}" followed by a concise answer (one or two sentences).`,
    LANGUAGE_RULE,
    '',
    `Question: ${question}`,
  ], effort).join('\n');
}

/** Heuristic for a "no answer" reply, used to decide whether a run whose tool call failed is retried with context in the prompt. */
export function isDontKnow(text) {
  const t = String(text || '');
  if (!t.trim()) return true;
  if (/\b(don'?t|do not|does not|doesn'?t|did not|not) (know|have|find|contain)|no (relevant )?(information|facts?|results?|context)|couldn'?t find|cannot find|unable to find|nothing relevant|not (yet )?(available|known)/i.test(t)) return true;
  // Spanish: "Todavía no lo sé.", "No lo sé", "no tengo (esa) información", "no hay datos / resultados", "no encuentro"
  // (JS `\b` ignores accented letters, so the boundaries are spelled out)
  return /(?:^|[^a-záéíóúñ])(?:no (?:lo )?s[eé]|(?:todav[ií]a|a[uú]n) no|no (?:tengo|hay|encuentro|contiene)|sin (?:informaci[oó]n|datos|resultados))(?![a-záéíóúñ])/i.test(t);
}

/**
 * Splits streamed text at the ANSWER: marker so any visible "thinking" the
 * model emits before it (gpt-oss does) is not streamed to the audience.
 *
 * The answer is one line. gpt-oss sometimes keeps "thinking" in plain text
 * after a first ANSWER: line (often glued on without a space, e.g.
 * "...yet.We must search again"), calls another tool and writes a second
 * ANSWER: line. So streaming stops at the end of the first answer line: a
 * newline, a sentence end glued to a capital letter, a leaked Harmony/channel
 * control token, or a tool call (close()). The final text is the last ANSWER:
 * segment, cut the same way; the `answer` event carries it and replaces
 * whatever was streamed.
 *
 * Nothing before the marker is ever emitted or returned: a run that never
 * writes ANSWER: finishes with `{ text: '', noMarker: true }` and the caller
 * decides what to answer (server/pipeline/real.js runs its guard path).
 */
const GLUED_SENTENCE = /[a-z0-9)\]"'’][.!?](?=[A-Z])/;
/**
 * gpt-oss Harmony chat-template leaks that sometimes trail an answer when the
 * model keeps going: `<|end|>`, `<|start|>assistant<|channel|>analysis<|message|>…`,
 * `<|return|>`, or the same without the control tokens (`assistantfinal`,
 * `assistantanalysis`, `analysisWe should…`). A lone `<|` is cut too so a
 * control token split across streamed deltas never leaks its first half.
 */
const HARMONY_JUNK = /<\||\bassistant(?:final|analysis|commentary)\b|(?<=^|[\s.!?])(?:analysis|final|commentary)(?=[A-Z<])/;
const HARMONY_WORDS = ['assistantfinal', 'assistantanalysis', 'assistantcommentary', 'analysis', 'final', 'commentary'];
/** Trailing text that may be the first half of a Harmony token split across deltas: held back until the next delta decides. */
function partialJunkAt(text) {
  const m = /(?:^|[\s.!?])([A-Za-z]{1,20})$/.exec(text);
  if (m && HARMONY_WORDS.some((w) => w.startsWith(m[1]))) return text.length - m[1].length;
  return text.endsWith('<') ? text.length - 1 : -1;
}

function firstAnswerLine(text) {
  const t = String(text || '').replace(/^\s+/, '');
  let end = t.length;
  const nl = t.search(/\r?\n/);
  if (nl !== -1) end = nl;
  const junk = HARMONY_JUNK.exec(t.slice(0, end));
  if (junk) end = junk.index;
  const glued = GLUED_SENTENCE.exec(t.slice(0, end));
  if (glued) end = glued.index + 2;
  return { text: t.slice(0, end).replace(/\s+$/, ''), complete: end < t.length };
}

/** Last defence for a finished answer: drop any Harmony/channel junk and whatever follows it. */
export function stripHarmonyJunk(text) {
  const t = String(text || '');
  const junk = HARMONY_JUNK.exec(t);
  return (junk ? t.slice(0, junk.index) : t).trim();
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
    let visible = line.text;
    if (!line.complete && next === -1) {
      const hold = partialJunkAt(visible);
      if (hold !== -1) visible = visible.slice(0, hold).replace(/\s+$/, '');
    }
    const out = visible.length > this.emitted.length ? visible.slice(this.emitted.length) : '';
    if (out) { this.emitted += out; this.onToken(out, this.i++); }
    if (line.complete || next !== -1) this.closed = true;
  }
  /** The model moved on (e.g. another tool call): stop streaming the current answer line. */
  close() {
    if (this.found && this.emitted) this.closed = true;
  }
  /**
   * Final answer: the last ANSWER: segment. If the model never used the marker
   * nothing is emitted and the text is empty (`noMarker: true`): pre-marker
   * text is reasoning and never reaches the audience.
   */
  finish() {
    if (!this.found) return { text: '', tokens: this.i, noMarker: true };
    const at = this.raw.lastIndexOf(MARKER);
    const last = stripHarmonyJunk(firstAnswerLine(this.raw.slice(at + MARKER.length)).text);
    return { text: last || stripHarmonyJunk(this.emitted), tokens: this.i, noMarker: false };
  }
}

/**
 * A harness tool event that cannot have grounded the answer: OpenCode reports a
 * malformed tool call (bad JSON arguments, unknown tool) as tool `invalid`, and
 * failed calls arrive as `run.tool_call_failed` / `status: "error"` / `error`.
 */
export function isInvalidToolEvent(type, d = {}) {
  const name = normalizeToolName(d.tool || d.name || d.tool_name);
  if (name === 'invalid') return true;
  if (/fail|error|invalid/i.test(String(type || ''))) return true;
  const status = String(d.status || d.state || '').toLowerCase();
  if (/^(error|failed|failure|invalid)$/.test(status)) return true;
  return d.error != null && d.error !== false && d.error !== '';
}

const KNOWN_EVENTS = new Set(['run.started', 'run.token_delta', 'run.usage_recorded', 'run.completed', 'run.failed', 'run.log']);
const isToolEventType = (type) => /tool/i.test(type || '');

/** Name of a rotated session: `<base>-r<timestamp36>`; unique per creation. */
export function rotatedName(base, now = Date.now()) {
  return `${base}-r${now.toString(36)}`;
}

/** True for the base session or one of its `-r<ts>` rotations. */
export function isSessionOf(base, name) {
  const n = String(name || '');
  return n === base || n.startsWith(`${base}-r`);
}

const isDead = (s) => /DESTROY|FAILED/.test(s?.status || '');
const createdAt = (s) => Date.parse(s?.created_at || '') || 0;

/** The rotation warm-up run may include the OpenCode boot of a fresh session (~5 s to run.started): a wider liveness window. */
const WARM_FIRST_TOKEN_MS = 60000;
/** Re-attach back-off: a normal (ref'd) timer, bounded and only pending while a re-attach is due. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One long-lived `GET /sessions/{id}/events` attach per session.
 *
 * The events endpoint keeps one live delivery slot per client and a new attach supersedes
 * the previous one. Opening a fresh attach for every question (and aborting it afterwards)
 * made each question pay 3-4 s for that supersede and sometimes hung or produced a zombie
 * stream: the 45 s "stalls" where the POST was never even sent (bench/INVESTIGATION.md).
 * So the stream is opened once when a session becomes current (warm-up, rotation), stays
 * open across questions and is only re-attached when it actually ends: then with
 * `Last-Event-ID` so nothing in between is missed. Delivery is at-least-once, so events are
 * de-duplicated by `event_id`. Events are routed to the run that owns them (`run_id`); events
 * of a run nobody follows yet are buffered, because the POST /input response carrying the run
 * id can land after the run's first events. A silent stream (the server sends a keepalive
 * comment every ~15 s) is re-attached by the idle watchdog; a run that times out without a
 * single event forces a re-attach too (zombie attach). A 404 is final: the session is gone.
 */
export class SessionStream {
  constructor(sessionId, { url, headers, fetch: fetchImpl, log, attachTimeoutMs = 20000, idleMs = 60000, backoffMs = 500, maxBackoffMs = 10000, bufferSize = 1000 }) {
    this.sessionId = sessionId;
    this.url = url;
    this.headers = typeof headers === 'function' ? headers : () => headers;
    this.fetch = fetchImpl;
    this.logger = typeof log === 'function' ? log : () => log || console;
    this.attachTimeoutMs = attachTimeoutMs;
    this.idleMs = idleMs;
    this.backoffMs = backoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.bufferSize = bufferSize;
    this.deviceId = randomUUID();
    this.state = 'idle'; // idle | connecting | attached | live | reconnecting | closed
    this.closed = false;
    this.fatal = null;
    this.loop = null;
    this.ac = null;
    this.idleTimer = null;
    this.attaches = 0;
    this.drops = 0;
    this.events = 0;
    this.lastEventId = '';
    this.lastEventAt = null;
    this.attachedAt = null;
    this.openedAt = Date.now();
    this.lastError = null;
    this.subs = new Map(); // run_id -> Set<{ onEvent, onError }>
    this.recent = []; // events of runs nobody has subscribed to (yet)
    this.seen = new Set(); // event ids, bounded
  }

  get log() {
    return this.logger();
  }

  /** Start the attach loop (idempotent). */
  start() {
    if (!this.loop && !this.closed) {
      this.loop = this._loop().catch((err) => this.log.error?.(`[harness] event stream of ${this.sessionId} loop crashed: ${err.message}`));
    }
    return this;
  }

  /** Stop for good: every follower is told the stream is closed. */
  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    this.state = 'closed';
    this.ac?.abort(new Error(`event stream ${reason}`));
    this._notifyError(Object.assign(new Error(`Harness event stream ${reason}`), { streamClosed: true }));
  }

  /** Drop the current attach and re-attach (with Last-Event-ID). */
  reconnect(reason = 'forced') {
    if (this.closed) return;
    this.log.log?.(`[harness] event stream of ${this.sessionId}: re-attaching (${reason})`);
    this.ac?.abort(new Error(`re-attach: ${reason}`));
  }

  /**
   * Follow one run. Buffered events of that run are delivered first (asynchronously, so the
   * caller can finish wiring), then live ones. Returns the unsubscribe function.
   */
  subscribe(runId, onEvent, onError = () => {}) {
    const sub = { onEvent, onError };
    let set = this.subs.get(runId);
    if (!set) this.subs.set(runId, (set = new Set()));
    set.add(sub);
    const pending = this.recent.filter((e) => e.run_id === runId);
    if (pending.length) this.recent = this.recent.filter((e) => e.run_id !== runId);
    queueMicrotask(() => {
      for (const e of pending) {
        if (!set.has(sub)) return;
        onEvent(e);
      }
      if (this.closed && set.has(sub)) onError(this.fatal || Object.assign(new Error('Harness event stream closed'), { streamClosed: true }));
    });
    return () => {
      set.delete(sub);
      if (!set.size && this.subs.get(runId) === set) this.subs.delete(runId);
    };
  }

  /** Health snapshot (no secrets). */
  status() {
    return {
      sessionId: this.sessionId,
      state: this.state,
      attaches: this.attaches,
      drops: this.drops,
      events: this.events,
      lastEventId: this.lastEventId || null,
      attachedAt: this.attachedAt,
      lastEventAt: this.lastEventAt,
      openMs: Date.now() - this.openedAt,
      lastError: this.lastError,
      following: this.subs.size,
    };
  }

  _notifyError(err) {
    for (const [, set] of [...this.subs]) for (const sub of [...set]) {
      try { sub.onError(err); } catch { /* the follower's problem */ }
    }
  }

  async _loop() {
    let backoff = this.backoffMs;
    while (!this.closed) {
      const ac = new AbortController();
      this.ac = ac;
      const attachTimer = setTimeout(() => ac.abort(new Error(`attach timed out after ${this.attachTimeoutMs} ms`)), this.attachTimeoutMs);
      attachTimer.unref?.();
      this.state = this.attaches ? 'reconnecting' : 'connecting';
      try {
        const headers = { ...this.headers(), accept: 'text/event-stream', 'cache-control': 'no-cache', 'x-device-uuid': this.deviceId };
        if (this.lastEventId) headers['last-event-id'] = this.lastEventId;
        const res = await this.fetch(`${this.url}/events`, { headers, signal: ac.signal });
        clearTimeout(attachTimer);
        if (!res.ok) {
          const err = Object.assign(new Error(`Harness events failed: ${res.status}`), { status: res.status, recoverable: res.status === 404, beforeFirstToken: true });
          if (res.status === 404) {
            // the session is gone: nothing to re-attach to
            this.fatal = err;
            this.lastError = { at: Date.now(), message: err.message };
            this.closed = true;
            this.state = 'closed';
            this._notifyError(err);
            return;
          }
          throw err;
        }
        if (!res.body) throw new Error('Harness events: empty body');
        this.attaches++;
        this.attachedAt = Date.now();
        this.state = 'attached';
        backoff = this.backoffMs;
        await this._read(res.body, ac);
        throw new Error('event stream ended');
      } catch (err) {
        clearTimeout(attachTimer);
        if (this.closed) return;
        this.drops++;
        this.lastError = { at: Date.now(), message: err.message };
        this.state = 'reconnecting';
        this.log.log?.(`[harness] event stream of ${this.sessionId} dropped (${err.message}); re-attaching in ${backoff} ms`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, this.maxBackoffMs);
      }
    }
  }

  async _read(body, ac) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const aborted = new Promise((_, reject) => ac.signal.addEventListener('abort', () => reject(ac.signal.reason || new Error('aborted')), { once: true }));
    aborted.catch(() => {});
    const idle = () => {
      clearTimeout(this.idleTimer);
      if (this.idleMs > 0) {
        this.idleTimer = setTimeout(() => ac.abort(new Error(`no data for ${this.idleMs} ms`)), this.idleMs);
        this.idleTimer.unref?.();
      }
    };
    let buf = '';
    try {
      idle();
      for (;;) {
        const { value, done } = await Promise.race([reader.read(), aborted]);
        if (done) return;
        idle();
        buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          this._frame(frame);
        }
      }
    } finally {
      clearTimeout(this.idleTimer);
      reader.cancel().catch(() => {});
    }
  }

  _frame(frame) {
    let id = '';
    const data = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue; // keepalive comment
      if (line.startsWith('id:')) id = line.slice(3).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (!data.length) return;
    let e;
    try { e = JSON.parse(data.join('\n')); } catch { return; }
    if (!e || typeof e !== 'object') return;
    const eventId = String(e.event_id || id || '');
    if (eventId) {
      if (this.seen.has(eventId)) return; // at-least-once delivery: duplicates are dropped
      this.seen.add(eventId);
      if (this.seen.size > this.bufferSize * 2) this.seen.delete(this.seen.values().next().value);
      this.lastEventId = eventId;
    }
    if (e.type === 'stream.state') {
      if (e.data?.state === 'live') this.state = 'live';
      return;
    }
    this.events++;
    this.lastEventAt = Date.now();
    const set = this.subs.get(String(e.run_id || ''));
    if (set && set.size) {
      for (const sub of [...set]) sub.onEvent(e);
    } else {
      this.recent.push(e);
      if (this.recent.length > this.bufferSize) this.recent.shift();
    }
  }
}

export class HarnessClient {
  constructor(cfg, fetchImpl = (...a) => fetch(...a), log = console) {
    this.cfg = cfg;
    this.fetch = fetchImpl;
    this.log = log;
    this.sessionId = null;
    this.sessionName = null;
    this.queue = Promise.resolve(); // one run at a time per session
    this.seenEventTypes = new Set();
    // session hygiene (see rotate()): questions answered on the current session, when it was last used,
    // and the state of the background rotation
    this.questionCount = 0;
    this.lastUsedAt = null;
    this.rotations = 0;
    this.rotating = null; // promise of the rotation in flight (only one at a time)
    this.lastRotation = null; // { from, to, at, ms, reason, deletedOld }
    this.lastRotationError = null; // { at, message, from, to, reason }
    this.rotateBackoffUntil = 0;
    this.cleanup = Promise.resolve(); // background deletion of older duplicate sessions found at boot
    this.streams = new Map(); // session id -> SessionStream (the current session, plus a rotation target while it warms)
  }

  /** The persistent event stream of a session, attached on first use and kept open (see SessionStream). */
  _stream(id) {
    let s = this.streams.get(id);
    if (s && !s.closed) return s;
    s = new SessionStream(id, {
      url: `${this.cfg.apiUrl}/${id}`,
      headers: () => this.headers(),
      fetch: (...a) => this.fetch(...a),
      log: () => this.log,
      attachTimeoutMs: this.cfg.attachTimeoutMs,
      idleMs: this.cfg.streamIdleMs,
      backoffMs: this.cfg.streamBackoffMs,
    });
    this.streams.set(id, s);
    return s.start();
  }

  _closeStream(id, reason) {
    const s = id && this.streams.get(id);
    if (!s) return;
    this.streams.delete(id);
    s.close(reason);
  }

  /** Close every event stream (shutdown / tests). */
  close(reason = 'client closed') {
    for (const id of [...this.streams.keys()]) this._closeStream(id, reason);
  }

  /** Health snapshot of the current session's event stream (null before the first attach). */
  streamStatus(id = this.sessionId) {
    const s = id && this.streams.get(id);
    return s ? s.status() : null;
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
    return (json.sessions || []).filter((s) => s.name === name && !isDead(s));
  }

  /** Every session of the account (paged with per_page/page). */
  async listSessions() {
    const perPage = 100;
    const all = [];
    for (let page = 1; page <= 50; page++) {
      const res = await this.fetch(`${this.cfg.apiUrl}?per_page=${perPage}&page=${page}`, { headers: this.headers() });
      if (!res.ok) throw new Error(`Harness list sessions failed: ${res.status} ${await res.text()}`);
      const json = await res.json();
      const batch = json.sessions || [];
      if (!batch.length) break;
      all.push(...batch);
      const total = json.meta?.total;
      if (Number.isFinite(total)) { if (all.length >= total) break; }
      else if (!json.links?.pages?.next && batch.length < perPage) break;
    }
    return all;
  }

  /**
   * Config path: the live sessions named after the base (`base` or `base-r<ts>`), created from
   * HARNESS_CONFIG_ID (when the API reports a config_id), newest first.
   */
  async candidates() {
    const base = this.cfg.sessionName;
    return (await this.listSessions())
      .filter((s) => isSessionOf(base, s.name) && !isDead(s) && (s.config_id == null || s.config_id === this.cfg.configId))
      .sort((a, b) => createdAt(b) - createdAt(a));
  }

  /**
   * Find a reusable session.
   * Config path (HARNESS_CONFIG_ID set): the newest session named `<base>` or `<base>-r<ts>` created
   * from the config; older duplicates are deleted in the background. This is the persistence: a
   * restart picks up the current rotated session by its name prefix.
   * Manifest path (no config): the base name if its manifest label matches the current fingerprint,
   * else `<name>-<hash>`. Stale sessions are never deleted there.
   */
  async findSession() {
    if (this.cfg.configId) {
      const [newest, ...older] = await this.candidates();
      if (older.length) {
        this.log.log?.(`[harness] ${older.length} older session${older.length === 1 ? '' : 's'} of ${this.cfg.sessionName} found: deleting in the background`);
        this.cleanup = Promise.all(older.map((s) => this.deleteSession(s.session_id, s.name)));
      }
      return { session: newest || null, name: newest ? newest.name : rotatedName(this.cfg.sessionName), stale: false };
    }
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

  /**
   * Create a session. With HARNESS_CONFIG_ID the JSON form `{name, config_id}` reuses the immutable
   * Environment Config (the YAML form would persist a new config every time); without it the YAML
   * manifest is posted.
   */
  async createSession(name) {
    let init;
    if (this.cfg.configId) {
      init = { method: 'POST', headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify({ name, config_id: this.cfg.configId }) };
    } else {
      if (!this.cfg.inferenceKey) throw new Error('HARNESS_INFERENCE_API_KEY missing');
      if (this.cfg.toolsMode === 'inline' && !this.cfg.mcpUrl) throw new Error('MCP_PUBLIC_URL missing (required with HARNESS_TOOLS_MODE=inline)');
      if (this.cfg.toolsMode === 'inline' && !this.cfg.mcpToken) throw new Error('MCP_AUTH_TOKEN missing (required with HARNESS_TOOLS_MODE=inline)');
      init = { method: 'POST', headers: this.headers({ 'content-type': 'application/x-yaml' }), body: buildManifest(this.cfg, name) };
    }
    const res = await this.fetch(this.cfg.apiUrl, init);
    if (!res.ok) throw new Error(`Harness create session failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    return json.session || json;
  }

  async getSession(id) {
    const res = await this.fetch(`${this.cfg.apiUrl}/${id}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Harness get session failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    return json.session || json;
  }

  /** Best effort DELETE; never throws, resolves true when the API accepted it. */
  async deleteSession(id, name = id) {
    if (!id) return false;
    this._closeStream(id, 'session deleted');
    try {
      const res = await this.fetch(`${this.cfg.apiUrl}/${id}`, { method: 'DELETE', headers: this.headers() });
      if (!res.ok && res.status !== 404) throw new Error(`${res.status} ${await res.text()}`);
      this.log.log?.(`[harness] session ${name} deleted`);
      return true;
    } catch (err) {
      this.log.error?.(`[harness] delete session ${name} failed: ${err.message}`);
      return false;
    }
  }

  /** Poll GET /sessions/{id} until it is READY (or fail on DESTROYED/FAILED or the timeout). */
  async waitReady(id, { timeoutMs = this.cfg.rotateReadyTimeoutMs, pollMs = this.cfg.rotatePollMs } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const s = await this.getSession(id);
      if (/READY/.test(s.status || '')) return s;
      if (isDead(s)) throw new Error(`session ${id} is ${s.status}`);
      if (Date.now() >= deadline) throw new Error(`session ${id} not ready after ${timeoutMs} ms (status ${s.status || 'unknown'})`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  _setSession(id, name) {
    this.sessionId = id;
    this.sessionName = name;
    this.questionCount = 0;
    this.lastUsedAt = null;
  }

  /** Returns { id, name, created, stale } for the session, creating it on first use. */
  async ensureSession(force = false) {
    if (this.sessionId && !force) return { id: this.sessionId, name: this.sessionName, created: false, stale: false };
    const forced = this.cfg.configId ? rotatedName(this.cfg.sessionName) : this.sessionName || this.cfg.sessionName;
    const found = force ? { session: null, name: forced, stale: false } : await this.findSession();
    let s = found.session;
    let created = false;
    if (!s) { s = await this.createSession(found.name); created = true; }
    this._setSession(s.session_id, found.name);
    this._stream(this.sessionId); // attach now, so the first question only pays for its POST
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
    const idleBefore = this.lastUsedAt ? t0 - this.lastUsedAt : 0;
    let session;
    try {
      session = await this.ensureSession();
    } catch (err) {
      throw Object.assign(err, { beforeFirstToken: true });
    }
    hooks.onSession?.({ ...session, toolsMode: this.cfg.toolsMode, hash: this.hash });
    let out;
    try {
      out = await this._run(session.id, prompt, hooks, t0);
    } catch (err) {
      if (!(retry && err.recoverable)) throw err;
      this._closeStream(this.sessionId, `session lost (${err.message})`);
      this.sessionId = null;
      const fresh = await this.ensureSession(err.status === 404);
      hooks.onSession?.({ ...fresh, retried: true, toolsMode: this.cfg.toolsMode, hash: this.hash });
      out = await this._run(fresh.id, prompt, hooks, t0);
    }
    this.questionCount++;
    this.lastUsedAt = Date.now();
    this.maybeRotate(idleBefore);
    return out;
  }

  /** After a question: start a background rotation when the session answered enough questions or sat idle too long. */
  maybeRotate(idleBefore = 0) {
    if (!this.cfg.configId || this.rotating) return null;
    const { rotateAfter, rotateIdleMs } = this.cfg;
    let reason = null;
    if (rotateAfter > 0 && this.questionCount >= rotateAfter) reason = `${this.questionCount} questions answered`;
    else if (rotateIdleMs > 0 && idleBefore > rotateIdleMs) reason = `idle for ${Math.round(idleBefore / 1000)} s`;
    if (!reason) return null;
    const r = this.rotate(reason);
    return r.started ? r : null;
  }

  /**
   * Session hygiene: replace the current session with a fresh one created from the config.
   * Non-blocking and one at a time: a new session is created, polled until READY and warmed with
   * one tiny run; only then is the switch enqueued on the per-session queue so it happens between
   * questions, and the old session is deleted (best effort). Questions keep using the old session
   * until the switch. A failed warm-up deletes the new session, keeps the old one serving and
   * backs off before trying again. Returns { started, skipped?, promise }.
   */
  rotate(reason = 'manual') {
    if (this.rotating) return { started: false, skipped: 'rotation already in progress', promise: this.rotating };
    if (!this.cfg.configId) return { started: false, skipped: 'HARNESS_CONFIG_ID not set', promise: Promise.resolve(null) };
    if (Date.now() < this.rotateBackoffUntil) return { started: false, skipped: `backing off after a failed rotation until ${new Date(this.rotateBackoffUntil).toISOString()}`, promise: Promise.resolve(null) };
    const p = this._rotate(reason)
      .catch((err) => {
        // _rotate handles its own failures; this only guards the switch/delete tail so nothing is ever unhandled
        this.lastRotationError = { at: Date.now(), message: err.message, from: this.sessionName, to: null, reason };
        this.log.error?.(`[harness] rotation failed: ${err.message}`);
        return { ok: false, error: err.message };
      })
      .finally(() => {
        if (this.rotating === p) this.rotating = null;
      });
    this.rotating = p;
    return { started: true, promise: p };
  }

  async _rotate(reason) {
    const t0 = Date.now();
    const from = { id: this.sessionId, name: this.sessionName };
    const name = rotatedName(this.cfg.sessionName, t0);
    this.log.log?.(`[harness] rotating session ${from.name || '(none)'} -> ${name} (${reason})`);
    let created = null;
    try {
      created = await this.createSession(name);
      await this.waitReady(created.session_id);
      const warmPrompt = withReasoning([`Reply with exactly: ${MARKER} ready`], this.cfg.reasoningEffort).join('\n');
      const warm = await this._run(created.session_id, warmPrompt, {}, Date.now(), { firstTokenTimeoutMs: Math.max(this.cfg.firstTokenTimeoutMs, WARM_FIRST_TOKEN_MS) });
      this.log.log?.(`[harness] session ${name} warm (${warm.totalMs} ms, "${warm.text}")`);
    } catch (err) {
      this.lastRotationError = { at: Date.now(), message: err.message, from: from.name, to: name, reason };
      this.rotateBackoffUntil = Date.now() + this.cfg.rotateBackoffMs;
      this.log.error?.(`[harness] rotation to ${name} failed: ${err.message}; keeping ${from.name || '(none)'}`);
      if (created?.session_id) await this.deleteSession(created.session_id, name);
      return { ok: false, error: err.message };
    }
    // switch between questions: enqueue on the per-session serial queue
    const sw = this.queue.then(() => {
      const old = { id: this.sessionId, name: this.sessionName };
      this._setSession(created.session_id, name);
      this.lastUsedAt = Date.now();
      this.rotations++;
      this.lastRotation = { from: old.name, to: name, at: Date.now(), ms: Date.now() - t0, reason, deletedOld: false };
      return old;
    });
    this.queue = sw.catch(() => {});
    const old = await sw;
    this.log.log?.(`[harness] session switched ${old.name || '(none)'} -> ${name} in ${Date.now() - t0} ms`);
    if (old.id && old.id !== created.session_id) {
      this.lastRotation.deletedOld = await this.deleteSession(old.id, old.name);
      this._closeStream(old.id, 'session rotated out');
    }
    this.lastRotationError = null;
    return { ok: true, from: old.name, to: name };
  }

  /**
   * One run on a session: POST /input at once (the persistent event stream is already attached,
   * or attaching in the background), then follow the run's events on that stream until
   * run.completed / run.failed. `firstTokenTimeoutMs` can be widened for warm-up runs.
   */
  async _run(id, prompt, hooks, t0, { firstTokenTimeoutMs = this.cfg.firstTokenTimeoutMs } = {}) {
    const stream = this._stream(id);
    const ac = new AbortController();
    const fail = (message, extra = {}) => Object.assign(new Error(message), extra);
    const timer = setTimeout(() => ac.abort(fail(`Harness run timed out after ${this.cfg.timeoutMs} ms`, { timeout: true })), this.cfg.timeoutMs);
    // liveness guard: nothing at all (no token, no tool activity) within the first-token window fails the run (server/app.js may then replay a recording)
    let firstTimer = setTimeout(() => ac.abort(fail(`Harness produced nothing within ${firstTokenTimeoutMs} ms`, { timeout: true, beforeFirstToken: true })), firstTokenTimeoutMs);
    const alive = () => {
      if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
    };
    const stats = { firstTokenMs: null, model: null, tokensIn: 0, tokensOut: 0, reasoningTokens: 0, harnessToolEvents: 0, invalidTool: 0 };
    const invalidCalls = new Set(); // call ids of malformed/failed tool calls, so their completion events are flagged too
    // "first token" = first answer token streamed to the audience (text after ANSWER:); hidden
    // reasoning and tool activity only count as liveness for the first-token timeout.
    let sawOutput = false;
    let runId = '';
    let runEvents = 0;
    const filter = new MarkerFilter((tok, i) => {
      if (stats.firstTokenMs == null) stats.firstTokenMs = Date.now() - t0;
      sawOutput = true;
      hooks.onToken?.(tok, i);
    });
    try {
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
      const json = await res.json().catch(() => ({}));
      runId = typeof json?.run_id === 'string' ? json.run_id.trim() : '';
      // the API notes the id "may be empty if OHR returned no run id": such a run could never be followed
      if (!runId) throw fail('Harness input returned no run id', { beforeFirstToken: true, noRunId: true });
      hooks.onRun?.({ runId, sessionId: id });

      return await new Promise((resolve, reject) => {
        let unsub = () => {};
        const settle = (fn, value) => { unsub(); fn(value); };
        const handle = (e) => {
          runEvents++;
          const d = e.data || {};
          if (e.type === 'run.started') hooks.onStarted?.(Date.now() - t0);
          else if (e.type === 'run.token_delta') {
            alive();
            if (!d.is_reasoning && typeof d.text === 'string') filter.push(d.text);
          } else if (e.type === 'run.usage_recorded') {
            stats.model = d.model_id || stats.model;
            stats.reasoningTokens += Number(d.usage?.reasoning_tokens) || 0;
          }
          else if (e.type === 'run.failed') throw fail(`Harness run failed: ${d.message || 'unknown error'}`, { beforeFirstToken: !sawOutput });
          else if (e.type === 'run.completed') {
            stats.tokensIn = d.total_tokens_in || 0;
            stats.tokensOut = d.total_tokens_out || 0;
            const out = filter.finish();
            if (stats.firstTokenMs == null && out.text) stats.firstTokenMs = Date.now() - t0;
            settle(resolve, { ...out, ...stats, totalMs: Date.now() - t0, runId, sessionId: id });
          } else if (isToolEventType(e.type)) {
            // tool-call events from the harness itself (names vary by adapter); the MCP server's own events are primary
            alive();
            filter.close();
            const callId = d.call_id ?? d.callId ?? d.tool_call_id ?? d.id;
            let invalid = isInvalidToolEvent(e.type, d);
            if (callId != null) {
              if (invalid) invalidCalls.add(callId);
              else if (invalidCalls.has(callId)) invalid = true;
            }
            if (invalid) stats.invalidTool++;
            else stats.harnessToolEvents++;
            hooks.onToolEvent?.({ type: e.type, data: d, ts: e.ts || Date.now(), invalid });
          } else if (!KNOWN_EVENTS.has(e.type) && !this.seenEventTypes.has(e.type)) {
            this.seenEventTypes.add(e.type);
            this.log.debug?.(`[harness] unhandled event type ${e.type}`);
          }
        };
        unsub = stream.subscribe(
          runId,
          (e) => { try { handle(e); } catch (err) { settle(reject, err); } },
          (err) => settle(reject, Object.assign(err, { beforeFirstToken: err.beforeFirstToken ?? !sawOutput }))
        );
        ac.signal.addEventListener('abort', () => settle(reject, ac.signal.reason || fail('Harness run aborted')), { once: true });
      });
    } catch (err) {
      if (ac.signal.aborted && ac.signal.reason) err = ac.signal.reason;
      if (err.beforeFirstToken === undefined) err.beforeFirstToken = !sawOutput;
      // a run that timed out without a single event on an attached stream: the attach may be a zombie, re-attach for the next run
      if (err.timeout && runId && runEvents === 0) stream.reconnect(`no events for run ${runId}`);
      throw err;
    } finally {
      clearTimeout(timer);
      alive();
      ac.abort();
    }
  }
}
