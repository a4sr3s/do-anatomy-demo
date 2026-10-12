import { useMemo, useState } from 'react';
import { InboxIcon, SearchIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldLabel } from '@/components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SidebarGroup, SidebarGroupContent, SidebarGroupLabel } from '@/components/ui/sidebar';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useStore, type LogEntry } from '@/anatomy/store';
import { fmtTimeNY } from '@/anatomy/format';

const SOURCES = ['spaces', 'functions', 'vectordb', 'kb', 'agent', 'gateway', 'tool', 'inference', 'job', 'system'] as const;
type Source = (typeof SOURCES)[number];

const sourceOf = (who: string): Source => (SOURCES.includes(who as Source) ? (who as Source) : 'system');

const WHO_CLASS: Record<string, string> = {
  spaces: 'text-stage-spaces',
  functions: 'text-stage-functions',
  vectordb: 'text-stage-vectordb',
  kb: 'text-stage-kb',
  agent: 'text-stage-agent',
  gateway: 'text-stage-gateway',
  tool: 'text-stage-gateway',
  inference: 'text-stage-inference',
  job: 'text-foreground',
};
const STATUS_CLASS: Record<string, string> = {
  start: 'text-primary',
  progress: 'text-muted-foreground',
  done: 'text-success',
  error: 'text-destructive',
};

/** Rolling SSE event log: newest first, America/New_York timestamps, per-stage latency. */
export function LogsSection() {
  const logs = useStore((s) => s.logs);
  const total = useStore((s) => s.logTotal);
  const [query, setQuery] = useState('');
  const [sources, setSources] = useState<string[]>([]);
  const [showProgress, setShowProgress] = useState(true);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return logs.filter((l) => {
      if (!showProgress && l.status === 'progress') return false;
      if (sources.length && !sources.includes(sourceOf(l.who))) return false;
      if (q && !`${l.who} ${l.status} ${l.what}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [logs, query, sources, showProgress]);

  return (
    <SidebarGroup className="flex min-h-0 flex-1 flex-col">
      <SidebarGroupLabel className="justify-between">
        <span>Event log</span>
        <span className="tabular-nums">
          {visible.length} / {total}
        </span>
      </SidebarGroupLabel>
      <SidebarGroupContent className="flex min-h-0 flex-1 flex-col gap-2 px-2">
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput placeholder="filter events…" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} aria-label="Filter events" />
        </InputGroup>
        <ToggleGroup type="multiple" variant="outline" size="sm" spacing={0} value={sources} onValueChange={setSources} className="flex-wrap" aria-label="Sources">
          {SOURCES.map((s) => (
            <ToggleGroupItem key={s} value={s} className={cn('text-xs', WHO_CLASS[s])}>
              {s}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Field orientation="horizontal">
          <Switch id="log-progress" size="sm" checked={showProgress} onCheckedChange={setShowProgress} />
          <FieldLabel htmlFor="log-progress" className="text-xs font-normal text-muted-foreground">
            show progress events
          </FieldLabel>
        </Field>

        {visible.length === 0 ? (
          <Empty className="border border-dashed p-4">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <InboxIcon />
              </EmptyMedia>
              <EmptyTitle>{logs.length === 0 ? 'Waiting for events' : 'Nothing matches'}</EmptyTitle>
              <EmptyDescription>{logs.length === 0 ? 'Every backend event over SSE lands here.' : 'Loosen the filter to see more.'}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <ul data-testid="log-list" className="flex flex-col pr-2 text-xs">
              {visible.map((l) => (
                <LogRow key={l.id} entry={l} />
              ))}
            </ul>
          </ScrollArea>
        )}
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function LogRow({ entry: l }: { entry: LogEntry }) {
  return (
    <li
      data-source={sourceOf(l.who)}
      data-status={l.status || undefined}
      className={cn('grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-2 border-b border-border/40 py-0.5 leading-5', l.stale && 'opacity-50')}
      title={`${l.who} ${l.status} ${l.what}`}
    >
      <span className="tabular-nums text-muted-foreground">
        {fmtTimeNY(l.ts)}
        {l.replay ? ' ↻' : ''}
      </span>
      <span className="truncate">
        <span className={cn('font-medium', WHO_CLASS[l.who] ?? 'text-muted-foreground', l.who === 'tool' && 'uppercase tracking-wider')}>{l.who}</span>{' '}
        <span className={STATUS_CLASS[l.status]}>{l.status}</span>{' '}
        <span className={cn(l.status === 'progress' ? 'text-muted-foreground' : 'text-foreground', l.who === 'tool' && 'font-mono text-stage-gateway')}>{l.what}</span>
      </span>
      <span className="tabular-nums text-warning">{l.latency != null ? `${l.latency} ms` : ''}</span>
    </li>
  );
}
