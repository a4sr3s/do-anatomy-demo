import { useEffect, useRef, useState } from 'react';
import { SendHorizonalIcon, UploadIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, InputGroupText } from '@/components/ui/input-group';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Spinner } from '@/components/ui/spinner';
import { mountAnatomy } from '@/anatomy/mount.js';
import { createBridge } from '@/anatomy/bridge';
import { setActions } from '@/anatomy/controller';
import { useStore, type Tone } from '@/anatomy/store';
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
      <div className="pointer-events-auto flex items-center gap-3">
        <SidebarTrigger data-testid="sidebar-trigger" />
        <span className="text-xs tracking-[0.12em]">Fig 1</span>
        <span className="hidden text-xs tracking-[0.12em] text-muted-foreground xl:inline">
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
                  {j.flow === 'ingest' ? 'fact' : 'question'} · {j.input.slice(0, 28)}
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

function AskDock() {
  const answer = useStore((s) => s.answer);
  const [fact, setFact] = useState('');
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState<Kind | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState(false);

  async function submit(kind: Kind) {
    const text = (kind === 'fact' ? fact : question).trim();
    if (!text || busy) return;
    setBusy(kind);
    setError(false);
    setStatus(kind === 'fact' ? 'uploading…' : 'asking…');
    try {
      const r = kind === 'fact' ? await api('/facts', { method: 'POST', body: { text } }) : await api('/ask', { method: 'POST', body: { question: text } });
      const sources = (r.sources || []).length;
      setStatus(
        r.fallback
          ? `replayed "${r.recording}" (fallback)`
          : kind === 'fact'
            ? `stored ${r.chunks} chunk${r.chunks === 1 ? '' : 's'} · ${r.total} rows`
            : `${sources} source${sources === 1 ? '' : 's'}`
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
        <Card size="sm" data-testid="answer-card">
          <CardHeader>
            <CardTitle className="text-xs tracking-wider text-muted-foreground uppercase">answer</CardTitle>
            {answer.question && <CardDescription className="truncate">? {answer.question}</CardDescription>}
            {answer.done && (
              <CardAction>
                <Badge variant="outline">
                  {answer.sources} source{answer.sources === 1 ? '' : 's'}
                </Badge>
              </CardAction>
            )}
          </CardHeader>
          <CardContent>
            <p className={cn('max-h-20 overflow-y-auto text-sm', answer.text || answer.streaming ? 'text-success' : 'text-muted-foreground', answer.streaming && 'answer-caret')}>
              {answer.text || (answer.streaming ? '' : 'ask a question and the tokens land here as they arrive')}
            </p>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardContent>
            <FieldGroup className="gap-2">
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
