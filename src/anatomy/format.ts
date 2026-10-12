/** Formatting helpers shared by the log view and the bridge. */

const NY_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
});

/** `HH:MM:SS.mmm` in America/New_York (the venue's wall clock). */
export function fmtTimeNY(ts: number): string {
  return NY_TIME.format(new Date(ts));
}

export const latencyMs = (ms: number) => (ms < 1 ? '<1' : Math.round(ms));

/* eslint-disable @typescript-eslint/no-explicit-any */
/** One human line per SSE event (what used to be rendered by ui.js `log`). */
export function describeEvent(e: any): { who: string; status: string; what: string } {
  const who = e.stage || e.type;
  const status = e.status || '';
  let what = '';
  if (e.type === 'hello') what = `connected · ${e.data?.mode} mode · ${e.data?.pipeline?.chunks ?? 0} rows`;
  else if (e.type === 'stage') what = e.detail || '';
  else if (e.type === 'job') what = `${e.flow}${e.data?.input ? ` "${String(e.data.input).slice(0, 70)}"` : ''}${e.data?.message ? ` ${e.data.message}` : ''}`;
  else if (e.type === 'answer') what = `${e.data?.sources?.length || 0} sources`;
  else if (e.type === 'tool') return describeTool(e);
  else if (e.type === 'fallback') what = e.data?.recording ? `${e.flow} → replaying ${e.data.recording}` : `${e.flow} → ${e.data?.to || 'fallback'} (${e.data?.reason || ''})`;
  else if (e.type === 'replay') what = e.data?.name || '';
  else what = e.detail || JSON.stringify(e.data || {}).slice(0, 80);
  return { who, status, what };
}

/** `TOOL search_facts(query=…) → pgvector · 3 hits · 120 ms` */
export function describeTool(e: any): { who: string; status: string; what: string } {
  const d = e.data || {};
  const args = Object.entries(d.args || {})
    .map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v.length > 40 ? `${v.slice(0, 37)}…` : v) : JSON.stringify(v)}`)
    .join(', ');
  const parts = [`${d.tool}(${args}) → ${d.target || '?'}`];
  if (d.phase === 'done') {
    if (d.summary) parts.push(d.summary);
    else if (d.hits !== undefined) parts.push(`${d.hits} hit${d.hits === 1 ? '' : 's'}`);
    if (d.ms != null) parts.push(`${d.ms} ms`);
  } else if (d.phase === 'error') parts.push(`failed: ${d.error || 'unknown error'}`);
  if (d.source === 'harness') parts.push('(harness event)');
  return { who: 'tool', status: d.phase || '', what: parts.join(' · ') };
}

export const fmtDuration = (s: number) => (s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);
