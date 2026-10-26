import { useEffect, useRef, useState } from 'react';
import { BotIcon, SendHorizonalIcon, UploadIcon, ZapIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, InputGroupText } from '@/components/ui/input-group';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Brand } from '@/components/brand';
import { Spinner } from '@/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { mountAnatomy } from '@/anatomy/mount.js';
import { createBridge } from '@/anatomy/bridge';
import { setActions } from '@/anatomy/controller';
import { setAskMode, store, useStore, type AnswerMeta, type AskMode, type Tone } from '@/anatomy/store';
import { pathLabel } from '@/anatomy/format';
import { api } from '@/events.js';

/** Full-viewport three.js scene with the floating HUD, inspector and fact/ask dock. */
export function SceneView() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const bridge = createBridge();
    const handle = mountAnatomy(ref.current!, bridge);
    setActions(handle.actions);
    return () => {
      setActions(null);
      handle.dispose();
    };
  }, []);

  return (
    <div className="relative size-full">
      <div ref={ref} data-slot="scene" className="absolute inset-0" />
      <Hud />
      <InspectorCard />
      <AskDock />
    </div>
  );
}

const TONE_CLASS: Record<Tone, string> = { '': 'text-primary', ok: 'text-success', warn: 'text-warning', err: 'text-destructive' };

function Hud() {
  const fps = useStore((s) => s.fps);
  const conn = useStore((s) => s.conn);
  const mode = useStore((s) => s.mode);
  const modeTone = useStore((s) => s.modeTone);
  const legend = useStore((s) => s.legend);
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-4 p-3">
      <div className="pointer-events-auto flex min-w-0 items-center gap-3">
        <SidebarTrigger data-testid="sidebar-trigger" />
        <Brand />
        <span className="text-xs whitespace-nowrap tracking-[0.12em]">Fig 1</span>
        <span className="hidden min-w-0 truncate text-xs tracking-[0.12em] text-muted-foreground xl:block">
          DRAG ORBIT · SCROLL ZOOM · RIGHT-DRAG PAN · HOVER / CLICK INSPECT · DOUBLE-CLICK FOCUS · ESC RESET
        </span>
      </div>
      <div className="flex flex-col items-end gap-1.5">
        <div className="pointer-events-auto flex gap-2">
          <Badge variant="outline" className="tabular-nums">
            {fps} fps
          </Badge>
          <Badge variant="outline" className={conn === 'open' ? 'text-success' : 'text-warning'}>
            {conn === 'open' ? 'sse live' : 'sse reconnecting'}
          </Badge>
          <Badge variant="outline" className={TONE_CLASS[modeTone]}>
            {mode}
          </Badge>
        </div>
        <span className="text-[11px] tracking-[0.18em] text-muted-foreground">DIGITALOCEAN · AI DATA PIPELINE</span>
        {legend.length > 0 && (
          <ul className="hidden flex-col items-end gap-0.5 text-[11px] text-muted-foreground md:flex">
            {legend.map((j, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className="truncate">
                  {j.flow === 'ingest' ? 'fact' : j.flow === 'delete' ? 'delete' : 'question'} · {j.input.slice(0, 28)}
                  {j.input.length > 28 ? '…' : ''}
                </span>
                <span className="size-2 shrink-0" style={{ background: j.color, boxShadow: `0 0 8px ${j.color}` }} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function InspectorCard() {
  const { part, pinned, stats } = useStore((s) => s.inspector);
  if (!part) return null;
  const entries = Object.entries(stats);
  return (
    <Card size="sm" className={cn('absolute top-14 left-3 w-80 max-w-[calc(100%-1.5rem)]', pinned ? 'pointer-events-auto' : 'pointer-events-none')}>
      <CardHeader>
        <CardTitle className="truncate">{part.machineTitle ? `${part.machineTitle} · ${part.title}` : part.title}</CardTitle>
        <CardDescription>{pinned ? 'pinned · click empty space to unpin' : part.machineLabel || 'board'}</CardDescription>
        {pinned && (
          <CardAction>
            <Badge variant="outline">pinned</Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="line-clamp-4 text-xs text-muted-foreground">{part.desc}</p>
        {entries.length > 0 && (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
            {entries.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2 border-b border-border/60">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="truncate text-warning">{String(v)}</dd>
              </div>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

type Kind = 'fact' | 'ask';

/**
 * The two answer paths (POST /api/ask {mode}); the server resolves `fast` to search-first on direct
 * Serverless Inference with reasoning low and `agent` to the tool path in the Harness Runtime.
 */
const MODES: { key: AskMode; label: string; short: string; icon: typeof ZapIcon; hint: string }[] = [
  {
    key: 'fast',
    label: 'Fast · direct inference',
    short: 'fast',
    icon: ZapIcon,
    hint: 'Fixed retrieval, one model call: the App Platform embeds the question, searches pgvector itself and streams the answer from Serverless Inference (≈1 s). Use it for known look-ups; the Harness and the Gateway stay idle.',
  },
  {
    key: 'agent',
    label: 'Agent · Harness + Action Gateway',
    short: 'agent',
    icon: BotIcon,
    hint: 'Agent planning with tools: the OpenCode agent in the Harness Runtime decides what to look up and calls search_facts / get_document through the Action Gateway, then answers (≈4 s). Use it when the model should choose which facts to fetch.',
  },
];

const secs = (ms: number | null | undefined) => (ms == null ? '—' : `${(ms / 1000).toFixed(2)} s`);

/** `first token 0.61 s · total 0.86 s` (+ tool calls on the agent path, + fallback when one happened) */
function timingText(m: AnswerMeta | null) {
  if (!m) return '—';
  const parts = [`first token ${secs(m.timing.firstTokenMs)}`, `total ${secs(m.timing.totalMs)}`];
  if (m.timing.toolCalls) parts.push(`${m.timing.toolCalls} tool call${m.timing.toolCalls === 1 ? '' : 's'}`);
  if (m.fallback) parts.push(`fallback ${m.fallback}`);
  return parts.join(' · ');
}

/** Wake the harness session when the presenter switches to Agent, so the first agent question is not the one that thaws it. */
async function warmAgent() {
  store.set({ agentReady: { state: 'warming', detail: 'waking the harness session…', at: Date.now() } });
  try {
    const r = await api('/harness/warm', { method: 'POST' });
    if (r.skipped) store.set({ agentReady: { state: 'skipped', detail: r.reason || 'no harness', at: Date.now() } });
    else if (r.ok === false) store.set({ agentReady: { state: 'error', detail: r.error || 'harness not ready', at: Date.now() } });
    else store.set({ agentReady: { state: 'ready', detail: `${String(r.status || '').replace(/^SESSION_STATUS_/, '').toLowerCase() || 'ready'}${r.resumed ? ' · resumed' : ''}${r.rotation ? ' · rotating' : ''}${r.throttled ? '' : r.ms != null ? ` · ${r.ms} ms` : ''}`, session: r.session || null, at: Date.now() } });
  } catch (err) {
    store.set({ agentReady: { state: 'error', detail: (err as Error).message, at: Date.now() } });
  }
}

function AskDock() {
  const answer = useStore((s) => s.answer);
  const askMode = useStore((s) => s.askMode);
  const latency = useStore((s) => s.latency);
  const agentReady = useStore((s) => s.agentReady);
  const [fact, setFact] = useState('');
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState<Kind | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState(false);
  const mode = MODES.find((m) => m.key === askMode) ?? MODES[0];

  // a page that loads in Agent mode (persisted toggle) warms the harness once too
  useEffect(() => {
    if (store.get().askMode === 'agent') warmAgent();
  }, []);

  function pickMode(v: string) {
    if (v !== 'fast' && v !== 'agent') return;
    setAskMode(v);
    if (v === 'agent') warmAgent();
  }

  async function submit(kind: Kind) {
    const text = (kind === 'fact' ? fact : question).trim();
    if (!text || busy) return;
    setBusy(kind);
    setError(false);
    setStatus(kind === 'fact' ? 'uploading…' : `asking (${mode.short})…`);
    try {
      const r = kind === 'fact' ? await api('/facts', { method: 'POST', body: { text } }) : await api('/ask', { method: 'POST', body: { question: text, mode: askMode } });
      const sources = (r.sources || []).length;
      const t = r.timing;
      setStatus(
        r.fallback
          ? `replayed "${r.recording}" (fallback)`
          : kind === 'fact'
            ? `stored ${r.chunks} chunk${r.chunks === 1 ? '' : 's'} · ${r.total} rows`
            : `${pathLabel(r) || mode.short} · ${sources} source${sources === 1 ? '' : 's'}${t ? ` · first token ${secs(t.firstTokenMs)} · total ${secs(t.totalMs)}` : ''}`
      );
      if (kind === 'fact') setFact('');
      else setQuestion('');
    } catch (err) {
      setError(true);
      setStatus(`error: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  const onKey = (kind: Kind) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') submit(kind);
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-3">
      <div className="pointer-events-auto flex w-full max-w-2xl flex-col gap-2">
        <Card size="sm" data-testid="answer-card" data-path={answer.path ?? undefined}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xs tracking-wider text-muted-foreground uppercase">
              answer
              {answer.path && answer.path !== 'harness' && (
                <Badge variant="outline" data-testid="answer-path" className={cn('normal-case tracking-normal', answer.path === 'fast' ? 'text-stage-functions' : 'text-stage-agent')}>
                  {answer.path === 'fast' ? <ZapIcon data-icon="inline-start" /> : <BotIcon data-icon="inline-start" />}
                  {pathLabel(answer.meta ?? { preset: answer.preset })}
                </Badge>
              )}
            </CardTitle>
            {answer.question && <CardDescription className="truncate">? {answer.question}</CardDescription>}
            {answer.done && (
              <CardAction>
                <Badge variant="outline">
                  {answer.sources} source{answer.sources === 1 ? '' : 's'}
                </Badge>
              </CardAction>
            )}
          </CardHeader>
          <CardContent className="flex flex-col gap-1.5">
            <p className={cn('max-h-20 overflow-y-auto text-sm', answer.text || answer.streaming ? 'text-success' : 'text-muted-foreground', answer.streaming && 'answer-caret')}>
              {answer.text || (answer.streaming ? '' : 'ask a question and the tokens land here as they arrive')}
            </p>
            {answer.meta && (
              <p data-testid="answer-timing" className="text-[11px] tabular-nums text-warning">
                measured · {timingText(answer.meta)}
                {answer.meta.reason && answer.meta.fallback ? ` (${answer.meta.reason})` : ''}
              </p>
            )}
            {(latency.fast || latency.agent) && (
              <dl data-testid="latency-compare" className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[11px] tabular-nums">
                {MODES.map((m) => (
                  <div key={m.key} className="contents">
                    <dt className={cn('flex items-center gap-1', m.key === 'fast' ? 'text-stage-functions' : 'text-stage-agent')}>
                      <m.icon className="size-3" />
                      last {m.short}
                    </dt>
                    <dd className="truncate text-muted-foreground" data-testid={`latency-${m.key}`}>
                      {timingText(latency[m.key])}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </CardContent>
        </Card>

        <Card size="sm">
          <CardContent>
            <FieldGroup className="gap-2">
              <Field>
                <FieldLabel id="ask-mode-label" className="sr-only">
                  Answer path
                </FieldLabel>
                <div className="flex flex-wrap items-center gap-2">
                  <ToggleGroup type="single" variant="outline" size="sm" spacing={0} aria-labelledby="ask-mode-label" value={askMode} onValueChange={pickMode} data-testid="ask-mode">
                    {MODES.map((m) => (
                      <ToggleGroupItem key={m.key} value={m.key} data-testid={`ask-mode-${m.key}`} aria-label={m.label} className={cn('gap-1.5 text-xs', askMode === m.key && (m.key === 'fast' ? 'text-stage-functions' : 'text-stage-agent'))}>
                        <m.icon className="size-3.5" />
                        {m.label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                  {askMode === 'agent' && agentReady && (
                    <Badge variant="outline" data-testid="agent-ready" title={agentReady.session ? `session ${agentReady.session}` : undefined} className={cn('max-w-[18rem] truncate', agentReady.state === 'ready' ? 'text-success' : agentReady.state === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
                      {agentReady.state === 'warming' ? <Spinner data-icon="inline-start" /> : null}
                      harness {agentReady.detail}
                    </Badge>
                  )}
                </div>
                <FieldDescription data-testid="ask-mode-hint" className="text-xs">
                  {mode.hint}
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="fact-input" className="sr-only">
                  Fact
                </FieldLabel>
                <InputGroup>
                  <InputGroupAddon>
                    <InputGroupText className="w-8 text-stage-functions">fact</InputGroupText>
                  </InputGroupAddon>
                  <InputGroupInput
                    id="fact-input"
                    data-testid="fact-input"
                    value={fact}
                    onChange={(e) => setFact(e.target.value)}
                    onKeyDown={onKey('fact')}
                    spellCheck={false}
                    placeholder='"The Q3 launch is in Austin on Oct 22"'
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton onClick={() => submit('fact')} disabled={busy !== null || !fact.trim()} aria-label="Submit fact">
                      {busy === 'fact' ? <Spinner data-icon="inline-start" /> : <UploadIcon data-icon="inline-start" />}
                      Submit
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              </Field>
              <Field>
                <FieldLabel htmlFor="ask-input" className="sr-only">
                  Question
                </FieldLabel>
                <InputGroup>
                  <InputGroupAddon>
                    <InputGroupText className="w-8 text-stage-kb">ask</InputGroupText>
                  </InputGroupAddon>
                  <InputGroupInput
                    id="ask-input"
                    data-testid="ask-input"
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    onKeyDown={onKey('ask')}
                    spellCheck={false}
                    placeholder='"When is the Q3 launch?"'
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton onClick={() => submit('ask')} disabled={busy !== null || !question.trim()} aria-label="Ask">
                      {busy === 'ask' ? <Spinner data-icon="inline-start" /> : <SendHorizonalIcon data-icon="inline-start" />}
                      Ask
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              </Field>
              {status && <FieldDescription className={cn('text-xs', error && 'text-destructive')}>{status}</FieldDescription>}
            </FieldGroup>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
