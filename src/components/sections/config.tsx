import { useEffect, useState } from 'react';
import { CircleIcon, PlayIcon, RotateCcwIcon, SquareIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from '@/components/ui/field';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SidebarGroup, SidebarGroupContent, SidebarGroupLabel } from '@/components/ui/sidebar';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { actions } from '@/anatomy/controller';
import { store, useStore, type Health } from '@/anatomy/store';
import { fmtDuration } from '@/anatomy/format';
import { api } from '@/events.js';
import { stageLabel } from '@/components.js';

const SPEEDS = ['0.5', '1', '2'];

/** Backend health + scene controls + replay / record (uses the existing /api/recordings endpoints). */
export function ConfigSection() {
  useHealthPolling();
  return (
    <>
      <BackendGroup />
      <SceneGroup />
      <ReplayGroup />
    </>
  );
}

function useHealthPolling() {
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const h = (await api('/health')) as Health;
        if (alive) store.set({ health: h, healthError: null, recorder: h.recorder });
      } catch (err) {
        if (alive) store.set({ healthError: (err as Error).message });
      }
    };
    load();
    const t = setInterval(load, 10000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
}

interface Service {
  name: string;
  detail: string;
  up: boolean | null;
}

function servicesFor(h: Health): Service[] {
  const p = h.pipeline as Record<string, unknown>;
  if (h.mode !== 'real') {
    return [
      { name: 'Mock pipeline', detail: `in-memory · delay ×${p.delayScale ?? 1}`, up: true },
      { name: 'Vector store', detail: `${p.chunks ?? 0} rows (local 128-dim embedder)`, up: true },
    ];
  }
  return [
    { name: 'App Platform', detail: 'web service · API + chunk & embed in-process', up: true },
    { name: 'Spaces', detail: 'object storage · PutObject / GetObject', up: Boolean(p.spaces) },
    { name: 'Managed Postgres', detail: `pgvector · ${p.chunks ?? 0} rows`, up: Boolean(p.database) },
    { name: 'Harness Runtime', detail: p.harness ? `${p.harnessModel ?? 'opencode'} · session ${p.harnessSession ?? ''}` : 'HARNESS_API_TOKEN not set', up: Boolean(p.harness) },
    { name: 'Action Gateway / MCP', detail: `tools mode ${p.toolsMode ?? 'gateway'}${p.mcp ? '' : ' · MCP_PUBLIC_URL not set'}`, up: p.toolsMode === 'none' ? null : Boolean(p.mcp) },
    {
      name: 'Serverless Inference',
      detail: p.inferenceVia
        ? `${p.harnessModel ?? 'gpt-oss-20b'} · ${p.answerMode === 'search-first' ? `search-first, one round via ${p.searchFirstBackend === 'direct' ? 'direct streaming' : 'harness session'}${p.searchFirstReasoningEffort && p.searchFirstReasoningEffort !== 'off' ? ` (reasoning ${p.searchFirstReasoningEffort})` : ''}` : 'tool path via harness session'}`
        : 'needs the harness token',
      up: Boolean(p.inferenceVia),
    },
    {
      name: 'Answer paths',
      detail: `server default ${p.answerMode === 'tool' ? 'agent (tool)' : `${p.searchFirstBackend === 'direct' ? 'fast' : 'search-first via harness'}`} · toggle: fast = direct inference, agent = harness + gateway`,
      up: null,
    },
    { name: 'Embeddings', detail: String(p.embedding ?? 'local-hash'), up: null },
  ];
}

function BackendGroup() {
  const health = useStore((s) => s.health);
  const healthError = useStore((s) => s.healthError);
  const recorder = useStore((s) => s.recorder);
  const conn = useStore((s) => s.conn);
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Backend</SidebarGroupLabel>
      <SidebarGroupContent className="px-2">
        <Card size="sm">
          <CardHeader>
            <CardTitle>/api/health</CardTitle>
            <CardDescription>{healthError ? `unreachable: ${healthError}` : health ? `up ${fmtDuration(health.uptime)} · replay fallback ${health.replayFallback ? 'on' : 'off'}` : 'loading…'}</CardDescription>
            <CardAction>
              <Badge variant="outline" className={cn(health?.mode === 'real' ? 'text-success' : 'text-primary')}>
                {health?.mode ?? '…'} mode
              </Badge>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <dl className="flex flex-col gap-1 text-xs">
              <Row k="events" v={conn === 'open' ? 'sse live' : 'sse reconnecting'} ok={conn === 'open'} />
              <Row k="recorder" v={recorder.recording ? `recording "${recorder.recording}"` : recorder.replaying ? `replaying "${recorder.replaying}"` : 'idle'} ok={null} />
              {health && <Row k="stages" v={health.stages.map(stageLabel).join(' → ')} ok={null} />}
            </dl>
            {health && (
              <>
                <CardDescription>Connected services</CardDescription>
                <dl className="flex flex-col gap-1 text-xs">
                  {servicesFor(health).map((s) => (
                    <Row key={s.name} k={s.name} v={s.detail} ok={s.up} />
                  ))}
                </dl>
              </>
            )}
          </CardContent>
        </Card>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function Row({ k, v, ok }: { k: string; v: string; ok: boolean | null }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border/60 pb-0.5">
      <dt className="shrink-0 text-muted-foreground">{k}</dt>
      <dd className="flex min-w-0 items-center gap-1.5">
        <span className="truncate">{v}</span>
        {ok !== null && (
          <Badge variant="outline" className={ok ? 'text-success' : 'text-muted-foreground'}>
            {ok ? 'ok' : 'off'}
          </Badge>
        )}
      </dd>
    </div>
  );
}

function SceneGroup() {
  const speed = useStore((s) => s.speed);
  const auto = useStore((s) => s.auto);
  const bloom = useStore((s) => s.bloom);
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Scene</SidebarGroupLabel>
      <SidebarGroupContent className="px-2">
        <Card size="sm">
          <CardContent>
            <FieldGroup className="gap-3">
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldTitle id="speed-label">Speed</FieldTitle>
                  <FieldDescription>animation clock multiplier</FieldDescription>
                </FieldContent>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  spacing={0}
                  aria-labelledby="speed-label"
                  value={String(speed)}
                  onValueChange={(v) => {
                    if (!v) return;
                    store.set({ speed: Number(v) });
                    actions()?.setSpeed(Number(v));
                  }}
                >
                  {SPEEDS.map((s) => (
                    <ToggleGroupItem key={s} value={s} aria-label={`${s}x`}>
                      {s.replace(/^0/, '')}x
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Field>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="auto-traffic">Auto traffic</FieldLabel>
                  <FieldDescription>alternate a sample fact and question every 9 s</FieldDescription>
                </FieldContent>
                <Switch
                  id="auto-traffic"
                  checked={auto}
                  onCheckedChange={(on) => {
                    store.set({ auto: on });
                    actions()?.setAuto(on);
                  }}
                />
              </Field>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="bloom">Bloom</FieldLabel>
                  <FieldDescription>WebGL glow pass (turn off on weak GPUs)</FieldDescription>
                </FieldContent>
                <Switch
                  id="bloom"
                  checked={bloom}
                  onCheckedChange={(on) => {
                    store.set({ bloom: on });
                    actions()?.setBloom(on);
                  }}
                />
              </Field>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldTitle>Camera</FieldTitle>
                  <FieldDescription>Esc or 0 also resets the view</FieldDescription>
                </FieldContent>
                <Button variant="outline" size="sm" onClick={() => actions()?.resetView()}>
                  <RotateCcwIcon data-icon="inline-start" />
                  Reset view
                </Button>
              </Field>
            </FieldGroup>
          </CardContent>
        </Card>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function ReplayGroup() {
  const recordings = useStore((s) => s.recordings);
  const recorder = useStore((s) => s.recorder);
  const speed = useStore((s) => s.speed);
  const [selected, setSelected] = useState('');
  const current = recordings.some((r) => r.name === selected) ? selected : (recordings[0]?.name ?? '');
  const replaying = Boolean(recorder.replaying);
  const recording = Boolean(recorder.recording);

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Replay &amp; record</SidebarGroupLabel>
      <SidebarGroupContent className="px-2">
        <Card size="sm">
          <CardHeader>
            <CardTitle>Recordings</CardTitle>
            <CardDescription>Saved SSE event streams replayed with their original timing: the safety net if the venue network fails.</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup className="gap-3">
              <Field>
                <FieldLabel htmlFor="recording">Recording</FieldLabel>
                <Select value={current} onValueChange={setSelected} disabled={recordings.length === 0}>
                  <SelectTrigger id="recording" className="w-full" size="sm">
                    <SelectValue placeholder={recordings.length ? 'pick a recording' : 'no recordings'} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {recordings.map((r) => (
                        <SelectItem key={r.name} value={r.name}>
                          {r.name} · {r.events} ev · {(r.duration / 1000).toFixed(1)}s
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <div className="flex flex-wrap gap-2">
                {replaying ? (
                  <Button variant="destructive" size="sm" onClick={() => actions()?.stopReplay()}>
                    <SquareIcon data-icon="inline-start" />
                    Stop replay
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" disabled={!current} onClick={() => actions()?.replay(current, speed)}>
                    <PlayIcon data-icon="inline-start" />
                    Play at {speed}x
                  </Button>
                )}
                <Button variant={recording ? 'destructive' : 'outline'} size="sm" onClick={() => actions()?.toggleRecord()}>
                  {recording ? <SquareIcon data-icon="inline-start" /> : <CircleIcon data-icon="inline-start" />}
                  {recording ? 'Stop rec' : 'Record'}
                </Button>
              </div>
              <FieldDescription>{recording ? `Recording "${recorder.recording}" – submit a fact or ask, then stop.` : 'Record live events to recordings/*.json, then replay them on stage.'}</FieldDescription>
            </FieldGroup>
          </CardContent>
        </Card>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
