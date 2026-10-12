import { EventEmitter } from 'node:events';

/**
 * Central event bus. Every pipeline stage emits here; the SSE endpoint and the
 * recorder both subscribe. Events are plain JSON objects:
 *   { id, ts, type, flow, jobId, stage?, status?, detail?, data?, replay? }
 *   type: hello | job | stage | tool | answer | fallback | replay | recorder
 */
export class EventBus extends EventEmitter {
  constructor({ historySize = 300 } = {}) {
    super();
    this.setMaxListeners(0);
    this.seq = 0;
    this.history = [];
    this.historySize = historySize;
  }

  /** Stamp and broadcast an event. Returns the stamped event. */
  publish(evt) {
    const e = { id: ++this.seq, ts: Date.now(), ...evt };
    this.history.push(e);
    if (this.history.length > this.historySize) this.history.shift();
    this.emit('event', e);
    return e;
  }

  /** Build a stage-scoped emitter for a job, used by pipelines. */
  forJob(jobId, flow, extra = {}) {
    const bus = this;
    return {
      jobId,
      flow,
      job(status, data = {}) {
        return bus.publish({ type: 'job', flow, jobId, status, data, ...extra });
      },
      stage(stage, status, detail = '', data = {}) {
        return bus.publish({ type: 'stage', flow, jobId, stage, status, detail, data, ...extra });
      },
      /** A tool call seen by the MCP server / Action Gateway (phase start|done|error). */
      tool(data = {}) {
        return bus.publish({ type: 'tool', flow, jobId, data, ...extra });
      },
      answer(text, sources = []) {
        return bus.publish({ type: 'answer', flow, jobId, data: { text, sources }, ...extra });
      },
      error(stage, message) {
        return bus.publish({ type: 'stage', flow, jobId, stage, status: 'error', detail: message, data: {}, ...extra });
      },
    };
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
