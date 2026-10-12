/**
 * Tiny external store for the React shell. The three.js/event code in
 * mount.js writes into it through the bridge; components read it with
 * `useStore(selector)`. Selectors must return values that already live in the
 * state (no fresh objects) so useSyncExternalStore can bail out cheaply.
 */
import { useSyncExternalStore } from 'react';

export type Section = 'architecture' | 'logs' | 'config';
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
  answer: { question: string; text: string; sources: number; streaming: boolean; done: boolean };
  inspector: { part: InspectorPart | null; pinned: boolean; stats: Stats };
  machineStats: Record<string, Stats>;
  recordings: Recording[];
  recorder: RecorderStatus;
  health: Health | null;
  healthError: string | null;
  speed: number;
  auto: boolean;
  bloom: boolean;
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
  answer: { question: '', text: '', sources: 0, streaming: false, done: false },
  inspector: { part: null, pinned: false, stats: {} },
  machineStats: {},
  recordings: [],
  recorder: { recording: null, replaying: null },
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
