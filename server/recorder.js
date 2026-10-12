import fs from 'node:fs/promises';
import path from 'node:path';
import { sleep } from './bus.js';

const SAFE = /^[a-zA-Z0-9._-]{1,80}$/;

/**
 * Records bus events to JSON files and replays them with their original
 * timing. Also keeps the latest successful job per flow so the server can
 * fall back to a replay when a real-mode stage fails on stage.
 */
export class Recorder {
  constructor(bus, { dir = './recordings', autoCapture = true } = {}) {
    this.bus = bus;
    this.dir = path.resolve(dir);
    this.active = null; // manual recording in progress
    this.replaying = null; // { name, cancel }
    this.jobs = new Map(); // jobId -> events (auto capture)
    this.latest = { ingest: null, query: null };
    this.autoCapture = autoCapture;
    bus.on('event', (e) => this.onEvent(e));
  }

  onEvent(e) {
    if (e.replay) return;
    if (this.active) this.active.events.push({ ...e, t: e.ts - this.active.startedAt });
    if (!this.autoCapture || !e.jobId) return;
    if (e.type === 'job' && e.status === 'start') this.jobs.set(e.jobId, { startedAt: e.ts, flow: e.flow, events: [] });
    const job = this.jobs.get(e.jobId);
    if (!job) return;
    job.events.push({ ...e, t: e.ts - job.startedAt });
    if (e.type === 'job' && (e.status === 'done' || e.status === 'error')) {
      this.jobs.delete(e.jobId);
      if (e.status === 'done') {
        const rec = { name: `auto-${e.flow}`, flow: e.flow, createdAt: new Date(e.ts).toISOString(), events: job.events };
        this.latest[e.flow] = rec;
        this.save(rec).catch(() => {});
      }
    }
  }

  get status() {
    return { recording: this.active ? this.active.name : null, replaying: this.replaying ? this.replaying.name : null };
  }

  start(name) {
    if (this.active) throw new Error(`Already recording "${this.active.name}"`);
    name = name || `rec-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    if (!SAFE.test(name)) throw new Error('Invalid recording name');
    this.active = { name, startedAt: Date.now(), events: [] };
    this.bus.publish({ type: 'recorder', status: 'recording', data: { name } });
    return { name };
  }

  async stop() {
    if (!this.active) throw new Error('Not recording');
    const { name, events, startedAt } = this.active;
    this.active = null;
    const rec = { name, createdAt: new Date(startedAt).toISOString(), events: events.filter((e) => e.type !== 'recorder') };
    await this.save(rec);
    this.bus.publish({ type: 'recorder', status: 'saved', data: { name, events: rec.events.length } });
    return { name, events: rec.events.length };
  }

  async save(rec) {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, `${rec.name}.json`), JSON.stringify(rec, null, 2));
  }

  async list() {
    await fs.mkdir(this.dir, { recursive: true });
    const files = (await fs.readdir(this.dir)).filter((f) => f.endsWith('.json'));
    const out = [];
    for (const f of files) {
      try {
        const rec = JSON.parse(await fs.readFile(path.join(this.dir, f), 'utf8'));
        out.push({ name: rec.name || f.replace(/\.json$/, ''), flow: rec.flow || null, createdAt: rec.createdAt, events: rec.events?.length || 0, duration: rec.events?.at(-1)?.t || 0 });
      } catch {
        /* skip unreadable */
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async load(name) {
    if (!SAFE.test(name)) throw new Error('Invalid recording name');
    const raw = await fs.readFile(path.join(this.dir, `${name}.json`), 'utf8');
    return JSON.parse(raw);
  }

  async remove(name) {
    if (!SAFE.test(name)) throw new Error('Invalid recording name');
    await fs.unlink(path.join(this.dir, `${name}.json`));
  }

  /** Replay events with original relative timing (divided by speed). Resolves when done. */
  async replay(nameOrRec, { speed = 1, reason = 'manual' } = {}) {
    if (this.replaying) throw new Error(`Already replaying "${this.replaying.name}"`);
    const rec = typeof nameOrRec === 'string' ? await this.load(nameOrRec) : nameOrRec;
    speed = Math.max(0.1, Math.min(Number(speed) || 1, 20));
    let cancelled = false;
    this.replaying = { name: rec.name, cancel: () => (cancelled = true) };
    this.bus.publish({ type: 'replay', status: 'start', replay: true, data: { name: rec.name, speed, reason, events: rec.events.length } });
    let last = 0;
    let answer = null;
    try {
      for (const e of rec.events) {
        if (cancelled) break;
        const wait = Math.max(0, (e.t ?? 0) - last) / speed;
        last = e.t ?? last;
        if (wait > 0) await sleep(wait);
        if (cancelled) break;
        const { id, ts, t, ...rest } = e;
        const out = this.bus.publish({ ...rest, replay: true, replayName: rec.name });
        if (out.type === 'answer') answer = out.data;
      }
    } finally {
      this.replaying = null;
      this.bus.publish({ type: 'replay', status: cancelled ? 'cancelled' : 'done', replay: true, data: { name: rec.name } });
    }
    return { name: rec.name, cancelled, answer };
  }

  stopReplay() {
    if (!this.replaying) return false;
    this.replaying.cancel();
    return true;
  }

  /** Pick a recording to fall back to for a flow: latest live job, else bundled sample. */
  async fallbackFor(flow) {
    if (this.latest[flow]) return this.latest[flow];
    for (const name of [`auto-${flow}`, `sample-${flow}`]) {
      try {
        return await this.load(name);
      } catch {
        /* try next */
      }
    }
    return null;
  }
}
