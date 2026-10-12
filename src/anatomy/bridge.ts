/**
 * Implements the UI contract that mount.js expects (the surface the old
 * ui.js exposed) on top of the React store + sonner toasts.
 */
import { toast } from 'sonner';
import { MACHINES } from '@/components.js';
import { store, MAX_LOG, type InspectorPart, type Stats, type Tone, type ConnState, type LegendJob, type Recording, type RecorderStatus, type Fact } from './store';
import { describeEvent } from './format';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Part = any;

const shallowEqual = (a: Stats, b: Stats) => {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
};

function describePart(p: Part): InspectorPart {
  const key = p.machine?.key as string | undefined;
  const m = key ? (MACHINES as Record<string, any>)[key] : null;
  return { key: p.key, title: p.title, desc: `${m ? m.desc + ' ' : ''}${p.desc}`, machineKey: key ?? null, machineTitle: m?.title ?? null, machineLabel: m?.label ?? null };
}

export function createBridge() {
  let statsProvider: (part: Part) => Stats = () => ({});
  let pinned: Part = null;
  let shown: Part = null;
  let logSeq = 0;
  const timers: ReturnType<typeof setInterval>[] = [];

  function show(part: Part) {
    const p = part || pinned;
    shown = p;
    store.set({ inspector: { part: p ? describePart(p) : null, pinned: Boolean(p) && pinned === p, stats: p ? statsProvider(p) : {} } });
  }

  timers.push(
    setInterval(() => {
      if (!shown) return;
      const stats = statsProvider(shown);
      if (!shallowEqual(stats, store.get().inspector.stats)) store.set((s) => ({ inspector: { ...s.inspector, stats } }));
    }, 300)
  );

  const bridge = {
    hover(part: Part) {
      if (pinned) return;
      show(part);
    },
    select(part: Part) {
      pinned = part || null;
      show(part);
    },
    setStatsProvider(fn: (part: Part) => Stats) {
      statsProvider = fn;
    },
    /** publish a snapshot of every machine's live stats for the Architecture section */
    trackMachineStats(stats: Record<string, Stats>) {
      let last = '';
      timers.push(
        setInterval(() => {
          const json = JSON.stringify(stats);
          if (json === last) return;
          last = json;
          store.set({ machineStats: JSON.parse(json) });
        }, 500)
      );
    },

    answerReset(question: string) {
      store.set({ answer: { question: question || '', text: '', sources: 0, streaming: true, done: false } });
    },
    answerAppend(token: string) {
      store.set((s) => ({ answer: { ...s.answer, text: s.answer.text + token, streaming: true } }));
    },
    answerSet(text: string, sources: unknown[] = []) {
      store.set((s) => ({ answer: { ...s.answer, text, sources: sources.length, streaming: false, done: true } }));
    },

    log(e: any, { latency, stale }: { latency?: number | string; stale?: boolean } = {}) {
      if (e.type === 'stage' && e.status === 'progress' && e.data?.token !== undefined) return; // one line per token is too chatty
      const { who, status, what } = describeEvent(e);
      const entry = { id: ++logSeq, ts: e.ts || Date.now(), who, status, what, latency, replay: Boolean(e.replay), stale: Boolean(stale) };
      store.set((s) => ({ logs: [entry, ...s.logs].slice(0, MAX_LOG), logTotal: s.logTotal + 1 }));
    },

    setFps(n: number) {
      if (store.get().fps !== n) store.set({ fps: n });
    },
    setMode(text: string, cls: Tone = '') {
      store.set({ mode: text, modeTone: cls });
    },
    setConn(state: ConnState) {
      store.set({ conn: state });
    },
    setLegend(jobs: LegendJob[]) {
      store.set({ legend: jobs });
    },
    toast(msg: string, cls: Tone = '', ms = 4500) {
      const opts = { duration: ms };
      if (cls === 'err') toast.error(msg, opts);
      else if (cls === 'warn') toast.warning(msg, opts);
      else toast(msg, opts);
    },
    setRecordings(list: Recording[], status: Partial<RecorderStatus> = {}) {
      store.set({ recordings: list });
      bridge.setRecorderStatus(status);
    },
    setRecorderStatus({ recording, replaying }: Partial<RecorderStatus> = {}) {
      store.set((s) => ({
        recorder: {
          recording: recording !== undefined ? recording : s.recorder.recording,
          replaying: replaying !== undefined ? replaying : s.recorder.replaying,
        },
      }));
    },
    setAuto(on: boolean) {
      store.set({ auto: on });
    },
    /** the stored facts list (refreshed by mount.js after every ingest / delete job) */
    setFacts(list: Fact[]) {
      store.set({ facts: list });
    },
    get pinned() {
      return pinned;
    },
    dispose() {
      timers.forEach(clearInterval);
    },
  };
  return bridge;
}

export type Bridge = ReturnType<typeof createBridge>;
