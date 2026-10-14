/**
 * Tiny external store for the React shell. The three.js/event code in
 * mount.js writes into it through the bridge; components read it with
 * `useStore(selector)`. Selectors must return values that already live in the
 * state (no fresh objects) so useSyncExternalStore can bail out cheaply.
 */
import { useSyncExternalStore } from 'react';

export type Section = 'architecture' | 'facts' | 'logs' | 'config';
/** The two answer paths the ask box offers (POST /api/ask {mode}); see ANSWER_PRESETS on the server. */
export type AskMode = 'fast' | 'agent';
/** How a question job ran, from its own events: `harness` = search-first on the harness backend / old recordings. */
export type AnswerPath = AskMode | 'harness';

export interface AnswerTiming {
  firstTokenMs: number | null;
  totalMs: number;
  toolCalls?: number;
  reasoningTokens?: number;
  searchMs?: number;
  embedCached?: boolean;
  hits?: number;
}

/** Measured outcome of one answered question (the `job done` event), kept per path for the fast / agent contrast. */
export interface AnswerMeta {
  path: AnswerPath;
  preset: string | null;
  backend: string | null;
  answerMode: string | null;
  fallback: string | null;
  reason: string | null;
  timing: AnswerTiming;
  at: number;
}
export type Tone = '' | 'ok' | 'warn' | 'err';
export type ConnState = 'connecting' | 'open' | 'reconnecting';

export interface LogEntry {
  id: number;
  ts: number;
  who: string;
  status: string;
  what: string;
  latency?: number | string;
  replay: boolean;
  stale: boolean;
}

/** One stored fact: a Spaces object plus its pgvector rows (GET /api/facts). */
export interface Fact {
  id: string;
  key: string;
  text: string;
  createdAt: number | null;
  chunks: number;
}

export interface LegendJob {
  flow: string;
  input: string;
  color: string;
}

export interface Recording {
  name: string;
  flow: string | null;
  createdAt?: string;
  events: number;
  duration: number;
}

export interface RecorderStatus {
  recording: string | null;
  replaying: string | null;
}

export interface Health {
  ok: boolean;
  mode: string;
  uptime: number;
  pipeline: Record<string, unknown>;
  recorder: RecorderStatus;
  replayFallback: boolean;
  stages: string[];
}

export interface InspectorPart {
  key: string;
  title: string;
  desc: string;
  machineKey: string | null;
  machineTitle: string | null;
  machineLabel: string | null;
}

export type Stats = Record<string, string | number>;

export interface State {
  section: Section;
  mode: string;
  modeTone: Tone;
  conn: ConnState;
  fps: number;
  legend: LegendJob[];
  logs: LogEntry[];
  logTotal: number;
  answer: { question: string; text: string; sources: number; streaming: boolean; done: boolean; path: AnswerPath | null; preset: string | null; meta: AnswerMeta | null };
  /** the ask box toggle (persisted in localStorage) */
  askMode: AskMode;
  /** last measured answer per path, so both latencies can be shown side by side */
  latency: Record<AskMode, AnswerMeta | null>;
  /** agent-mode readiness as reported by POST /api/harness/warm (null = not asked yet) */
  agentReady: { state: 'warming' | 'ready' | 'error' | 'skipped'; detail: string; at: number } | null;
  inspector: { part: InspectorPart | null; pinned: boolean; stats: Stats };
  machineStats: Record<string, Stats>;
  recordings: Recording[];
  recorder: RecorderStatus;
  facts: Fact[];
  health: Health | null;
  healthError: string | null;
  speed: number;
  auto: boolean;
  bloom: boolean;
}

const ASK_MODE_KEY = 'anatomy.askMode';
function readAskMode(): AskMode {
  try {
    const v = globalThis.localStorage?.getItem(ASK_MODE_KEY);
    return v === 'agent' ? 'agent' : 'fast';
  } catch {
    return 'fast';
  }
}
/** Persist the toggle so a page reload (or the replay safety net) keeps the presenter's choice. */
export function setAskMode(mode: AskMode) {
  store.set({ askMode: mode });
  try {
    globalThis.localStorage?.setItem(ASK_MODE_KEY, mode);
  } catch {
    /* private mode: the toggle still works for the session */
  }
}

const initial: State = {
  section: 'architecture',
  mode: 'connecting…',
  modeTone: '',
  conn: 'connecting',
  fps: 0,
  legend: [],
  logs: [],
  logTotal: 0,
  answer: { question: '', text: '', sources: 0, streaming: false, done: false, path: null, preset: null, meta: null },
  askMode: readAskMode(),
  latency: { fast: null, agent: null },
  agentReady: null,
  inspector: { part: null, pinned: false, stats: {} },
  machineStats: {},
  recordings: [],
  recorder: { recording: null, replaying: null },
  facts: [],
  health: null,
  healthError: null,
  speed: 1,
  auto: false,
  bloom: true,
};

let state: State = initial;
const listeners = new Set<() => void>();

export const store = {
  get: () => state,
  set(patch: Partial<State> | ((s: State) => Partial<State>)) {
    const p = typeof patch === 'function' ? patch(state) : patch;
    state = { ...state, ...p };
    for (const l of listeners) l();
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(state), () => selector(state));
}

export const MAX_LOG = 500;
