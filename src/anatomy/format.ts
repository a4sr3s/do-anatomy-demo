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
  else if (e.type === 'fallback') what = `${e.flow} → replaying ${e.data?.recording}`;
  else if (e.type === 'replay') what = e.data?.name || '';
  else what = e.detail || JSON.stringify(e.data || {}).slice(0, 80);
  return { who, status, what };
}

export const fmtDuration = (s: number) => (s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);
