import { ActivityIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { SidebarGroup, SidebarGroupContent, SidebarGroupLabel } from '@/components/ui/sidebar';
import { MACHINES, stageLabel } from '@/components.js';
import { useStore, type Stats } from '@/anatomy/store';

interface Machine {
  key: string;
  label: string;
  title: string;
  stage: string | null;
  sublabel?: string;
  desc: string;
  color: string;
}

const machines = Object.values(MACHINES as Record<string, Machine>);

/** The seven machines with their live counters, plus the jobs currently in flight. */
export function ArchitectureSection() {
  const machineStats = useStore((s) => s.machineStats);
  const legend = useStore((s) => s.legend);

  return (
    <>
      <SidebarGroup>
        <SidebarGroupLabel>Pipeline</SidebarGroupLabel>
        <SidebarGroupContent className="flex flex-col gap-2 px-2">
          <p className="text-xs text-muted-foreground">
            A fact goes CLIENT → SPACES → APP PLATFORM (chunk &amp; embed in the web service) → PGVECTOR. A question takes one of two paths, picked
            with the toggle above the ask box. <b>Fast</b>: CLIENT → APP PLATFORM (embeds the question, searches PGVECTOR itself) → SERVERLESS
            INFERENCE (one streamed round, reasoning low) → CLIENT; the Harness and the Gateway stay dark. <b>Agent</b>: CLIENT → HARNESS RUNTIME, where
            the OpenCode agent plans and calls search_facts: ACTION GATEWAY → MCP server → PGVECTOR (or SPACES for get_document) and back, then
            SERVERLESS INFERENCE streams the grounded answer to the CLIENT. If the tool path is down the app retrieves itself and passes the context in
            the prompt. Every motion in the scene is a backend event; the measured first-token / total latency of each answer is shown under the answer.
          </p>
          {machines.map((m) => (
            <MachineCard key={m.key} machine={m} stats={machineStats[m.key]} />
          ))}
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarGroup>
        <SidebarGroupLabel>Recent jobs</SidebarGroupLabel>
        <SidebarGroupContent className="px-2">
          {legend.length === 0 ? (
            <Empty className="border border-dashed p-4">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ActivityIcon />
                </EmptyMedia>
                <EmptyTitle>No jobs yet</EmptyTitle>
                <EmptyDescription>Submit a fact or ask a question from the dock on the scene.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="flex flex-col gap-1 text-xs">
              {legend.map((j, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className="size-2 shrink-0" style={{ background: j.color, boxShadow: `0 0 8px ${j.color}` }} />
                  <Badge variant="outline">{j.flow === 'ingest' ? 'fact' : 'question'}</Badge>
                  <span className="truncate text-muted-foreground">{j.input}</span>
                </li>
              ))}
            </ul>
          )}
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  );
}

function MachineCard({ machine: m, stats }: { machine: Machine; stats?: Stats }) {
  const entries = Object.entries(stats ?? {});
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="size-2 shrink-0" style={{ background: m.color, boxShadow: `0 0 6px ${m.color}` }} />
          <span className="truncate">{m.title}</span>
        </CardTitle>
        <CardDescription className="truncate text-[11px] tracking-wider">
          {m.label}
          {m.sublabel ? <span className="normal-case tracking-normal text-muted-foreground/70"> · {m.sublabel}</span> : null}
        </CardDescription>
        {m.stage && (
          <CardAction>
            <Badge variant="outline" title={`stage "${m.stage}"`}>
              {stageLabel(m.stage)}
            </Badge>
          </CardAction>
        )}
      </CardHeader>
      {entries.length > 0 && (
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
            {entries.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2 border-b border-border/60">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="truncate text-warning">{String(v)}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      )}
    </Card>
  );
}
