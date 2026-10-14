/**
 * Direct DigitalOcean Serverless Inference client (OpenAI-compatible
 * `POST /v1/chat/completions`, `stream: true`) for the search-first answer path
 * (`ANSWER_MODE=search-first`, `SEARCH_FIRST_BACKEND=direct`): the app has
 * already retrieved the facts, so the single model round only has to write the
 * answer. Nothing else goes through here; the Harness Runtime stays the backend
 * of the tool path and of `SEARCH_FIRST_BACKEND=harness`.
 *
 * Transport: `https.request` with one keep-alive agent per client, so the TLS
 * connection to inference.do-ai.run is reused between questions (Node's global
 * fetch drops idle connections after ~4 s, i.e. between every two questions).
 * The transport is injectable for tests (`request` option).
 *
 * Streaming: `delta.content` goes through the same ANSWER: MarkerFilter the
 * harness path uses (nothing before the marker is ever shown); gpt-oss reasoning
 * arrives on `delta.reasoning_content` / `delta.reasoning` and only counts as
 * liveness. `reasoning_effort` is sent when an effort is configured (`off`
 * sends nothing). Usage (`stream_options.include_usage`) feeds `reasoningTokens`.
 *
 * Failures before the first answer token are flagged `beforeFirstToken` so the
 * pipeline can fall back to the harness round (and server/app.js to a replay).
 */
import https from 'node:https';
import { MarkerFilter } from './harness.js';

export const DIRECT_EFFORTS = ['low', 'medium', 'high', 'off'];

export class DirectInference {
  constructor({ url, key, model, firstTokenTimeoutMs = 15000, timeoutMs = 90000, maxTokens = 300, request = null, keepAlive = true, log = console }) {
    this.url = new URL(`${String(url || 'https://inference.do-ai.run/v1').replace(/\/$/, '')}/chat/completions`);
    this.key = key || '';
    this.model = model;
    this.firstTokenTimeoutMs = firstTokenTimeoutMs;
    this.timeoutMs = timeoutMs;
    this.maxTokens = maxTokens;
    this.log = log;
    this.agent = keepAlive ? new https.Agent({ keepAlive: true, maxSockets: 4, timeout: 0 }) : false;
    this.request = request || ((url, opts, cb) => https.request(url, { ...opts, agent: this.agent }, cb));
    this.requests = 0;
    this.reused = 0;
  }

  /** Health snapshot (no secrets). */
  status() {
    const sockets = this.agent && this.agent.freeSockets ? Object.values(this.agent.freeSockets).reduce((n, a) => n + a.length, 0) : 0;
    return { host: this.url.host, model: this.model, requests: this.requests, reusedConnections: this.reused, idleConnections: sockets };
  }

  /** The request body for one prompt (exported logic for tests / the bench). */
  body(prompt, { effort = 'off' } = {}) {
    const e = String(effort || 'off').toLowerCase();
    return {
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: this.maxTokens,
      ...(e && e !== 'off' && DIRECT_EFFORTS.includes(e) ? { reasoning_effort: e } : {}),
    };
  }

  /**
   * One streamed completion. `hooks.onToken(token, index)` receives the visible answer tokens
   * (after ANSWER:), `hooks.onStarted(ms)` the response headers, `hooks.onReasoning(ms)` the
   * first reasoning delta. Resolves
   * { text, tokens, noMarker, model, firstTokenMs, totalMs, tokensIn, tokensOut, reasoningTokens, reused }
   * where firstTokenMs / totalMs are measured from `t0` (defaults to now).
   */
  ask(prompt, { effort = 'off', onToken, onStarted, onReasoning, t0 = Date.now() } = {}) {
    if (!this.key) return Promise.reject(Object.assign(new Error('HARNESS_INFERENCE_API_KEY missing (direct Serverless Inference)'), { beforeFirstToken: true }));
    const payload = JSON.stringify(this.body(prompt, { effort }));
    return new Promise((resolve, reject) => {
      let settled = false;
      let sawOutput = false;
      let firstReasoning = false;
      const stats = { firstTokenMs: null, model: null, tokensIn: 0, tokensOut: 0, reasoningTokens: 0 };
      const filter = new MarkerFilter((tok, i) => {
        if (stats.firstTokenMs == null) stats.firstTokenMs = Date.now() - t0;
        sawOutput = true;
        onToken?.(tok, i);
      });
      const timers = {};
      const fail = (message, extra = {}) => Object.assign(new Error(message), extra);
      const finish = (err, out) => {
        if (settled) return;
        settled = true;
        clearTimeout(timers.total);
        clearTimeout(timers.first);
        if (err) {
          if (err.beforeFirstToken === undefined) err.beforeFirstToken = !sawOutput;
          reject(err);
        } else resolve(out);
      };
      let req;
      const abort = (err) => { finish(err); try { req?.destroy(err); } catch { /* already gone */ } };
      timers.total = setTimeout(() => abort(fail(`Serverless Inference timeout: run not finished within ${this.timeoutMs} ms`, { timeout: true })), this.timeoutMs);
      timers.first = setTimeout(() => abort(fail(`Serverless Inference timeout: produced nothing within ${this.firstTokenTimeoutMs} ms`, { timeout: true, beforeFirstToken: true })), this.firstTokenTimeoutMs);
      const alive = () => { if (timers.first) { clearTimeout(timers.first); timers.first = null; } };
      const headers = { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${this.key}`, 'content-length': Buffer.byteLength(payload) };
      try {
        req = this.request(this.url, { method: 'POST', headers }, (res) => {
          const status = res.statusCode;
          this.requests++;
          const reused = Boolean(req.reusedSocket);
          if (reused) this.reused++;
          onStarted?.(Date.now() - t0, { status, reused });
          let buf = '';
          let errBody = '';
          res.setEncoding?.('utf8');
          const frame = (line) => {
            if (!line.startsWith('data:')) return;
            const d = line.slice(5).trim();
            if (!d || d === '[DONE]') return;
            let j;
            try { j = JSON.parse(d); } catch { return; }
            if (j.usage) {
              stats.tokensIn = j.usage.prompt_tokens || stats.tokensIn;
              stats.tokensOut = j.usage.completion_tokens || stats.tokensOut;
              stats.reasoningTokens = j.usage.completion_tokens_details?.reasoning_tokens ?? stats.reasoningTokens;
            }
            if (j.model) stats.model = j.model;
            const choice = j.choices?.[0];
            const delta = choice?.delta || {};
            if (j.error) throw fail(`Serverless Inference error: ${j.error.message || JSON.stringify(j.error)}`);
            if (typeof delta.reasoning_content === 'string' || typeof delta.reasoning === 'string') {
              alive();
              if (!firstReasoning) { firstReasoning = true; onReasoning?.(Date.now() - t0); }
            }
            if (typeof delta.content === 'string' && delta.content) {
              alive();
              filter.push(delta.content);
            }
          };
          res.on('data', (chunk) => {
            if (settled) return;
            if (status !== 200) { errBody += chunk; return; }
            buf += String(chunk).replace(/\r\n/g, '\n');
            let i;
            try {
              while ((i = buf.indexOf('\n')) !== -1) {
                const line = buf.slice(0, i).trim();
                buf = buf.slice(i + 1);
                frame(line);
              }
            } catch (err) {
              abort(err);
            }
          });
          res.on('end', () => {
            if (settled) return;
            if (status !== 200) return finish(fail(`Serverless Inference failed: ${status} ${errBody.slice(0, 300)}`, { status, beforeFirstToken: true }));
            try { if (buf.trim()) frame(buf.trim()); } catch (err) { return finish(err); }
            const out = filter.finish();
            if (stats.firstTokenMs == null && out.text) stats.firstTokenMs = Date.now() - t0;
            finish(null, { ...out, ...stats, model: stats.model || this.model, totalMs: Date.now() - t0, reused });
          });
          res.on('error', (err) => finish(fail(`Serverless Inference stream failed: ${err.message}`, { network: true })));
        });
        req.on('error', (err) => finish(fail(`Serverless Inference request failed: ${err.code || ''} ${err.message}`.replace(/\s+/g, ' ').trim(), { network: true, beforeFirstToken: !sawOutput })));
        req.end(payload);
      } catch (err) {
        finish(fail(`Serverless Inference request failed: ${err.message}`, { network: true, beforeFirstToken: true }));
      }
    });
  }
}
