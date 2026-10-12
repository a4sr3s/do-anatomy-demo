import { useEffect, useState } from 'react';
import { DatabaseIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SidebarGroup, SidebarGroupContent, SidebarGroupLabel } from '@/components/ui/sidebar';
import { Spinner } from '@/components/ui/spinner';
import { actions } from '@/anatomy/controller';
import { useStore, type Fact } from '@/anatomy/store';
import { fmtDateTimeNY } from '@/anatomy/format';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Stored facts (one Spaces object + its pgvector rows each) with per-fact
 * delete and a confirmed "clear all". The list lives in the store and is
 * refreshed by mount.js after every ingest / delete job; deleting here only
 * calls the API, the scene animates the removal from the SSE events.
 */
export function FactsSection() {
  const facts = useStore((s) => s.facts);
  const [busy, setBusy] = useState<string | null>(null); // fact id, 'all' or 'refresh'
  const [confirm, setConfirm] = useState(false);
  const chunks = facts.reduce((n, f) => n + (f.chunks || 0), 0);

  useEffect(() => {
    actions()?.refreshFacts();
  }, []);

  async function refresh() {
    setBusy('refresh');
    try {
      await actions()?.refreshFacts();
    } finally {
      setBusy(null);
    }
  }

  async function remove(fact: Fact) {
    if (busy) return;
    setBusy(fact.id);
    try {
      const r = await actions()!.deleteFact(fact.id);
      toast(`Deleted fact · ${plural(r.removed, 'row')} removed from pgvector, object removed from Spaces`);
    } catch (err) {
      toast.error(`Delete failed: ${(err as Error).message}`);
    } finally {
      await actions()?.refreshFacts();
      setBusy(null);
    }
  }

  async function clearAll() {
    if (busy) return;
    setBusy('all');
    try {
      const r = await actions()!.deleteAllFacts();
      toast(`Cleared ${plural(r.facts, 'fact')} · ${plural(r.removed, 'row')} removed from pgvector`);
    } catch (err) {
      toast.error(`Clear all failed: ${(err as Error).message}`);
    } finally {
      await actions()?.refreshFacts();
      setBusy(null);
    }
  }

  return (
    <SidebarGroup className="flex min-h-0 flex-1 flex-col">
      <SidebarGroupLabel className="justify-between">
        <span>Stored facts</span>
        <span className="tabular-nums" data-testid="facts-count">
          {plural(facts.length, 'fact')} · {plural(chunks, 'chunk')}
        </span>
      </SidebarGroupLabel>
      <SidebarGroupContent className="flex min-h-0 flex-1 flex-col gap-2 px-2">
        <p className="text-xs text-muted-foreground">
          Each fact is one object in SPACES plus its chunk rows in the VECTOR DB. Deleting removes both: the cubes lift out of pgvector, then the drawer
          gives up the document.
        </p>
        <div className="flex items-center justify-between gap-2">
          <Button variant="outline" size="sm" onClick={refresh} disabled={busy !== null} aria-label="Refresh facts">
            {busy === 'refresh' ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
            Refresh
          </Button>
          <AlertDialog open={confirm} onOpenChange={setConfirm}>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm" data-testid="facts-clear-all" disabled={busy !== null || facts.length === 0}>
                {busy === 'all' ? <Spinner data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}
                Clear all
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete all stored facts?</AlertDialogTitle>
                <AlertDialogDescription>
                  This removes {plural(chunks, 'row')} from pgvector and {plural(facts.length, 'object')} from the Spaces bucket. Questions will have
                  nothing to retrieve until new facts are submitted. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel data-testid="facts-clear-cancel">Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" data-testid="facts-clear-confirm" onClick={clearAll}>
                  Delete everything
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>

        {facts.length === 0 ? (
          <Empty className="border border-dashed p-4" data-testid="facts-empty">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <DatabaseIcon />
              </EmptyMedia>
              <EmptyTitle>No facts stored</EmptyTitle>
              <EmptyDescription>Submit a fact below the scene and it shows up here with its chunk count.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <ul data-testid="facts-list" className="flex flex-col gap-1 pr-2">
              {facts.map((f) => (
                <FactRow key={f.id} fact={f} busy={busy === f.id} disabled={busy !== null} onDelete={() => remove(f)} />
              ))}
            </ul>
          </ScrollArea>
        )}
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function FactRow({ fact, busy, disabled, onDelete }: { fact: Fact; busy: boolean; disabled: boolean; onDelete: () => void }) {
  return (
    <li
      data-testid="fact-row"
      data-fact-id={fact.id}
      className={cn('grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 rounded-md border border-border/60 bg-card/40 p-2 text-xs', busy && 'opacity-60')}
      title={fact.key}
    >
      <p className="line-clamp-3 text-foreground" data-testid="fact-text">
        {fact.text}
      </p>
      <Button variant="ghost" size="icon-xs" className="text-destructive hover:text-destructive" data-testid="fact-delete" aria-label="Delete fact" disabled={disabled} onClick={onDelete}>
        {busy ? <Spinner /> : <Trash2Icon />}
      </Button>
      <div className="col-span-2 mt-1 flex items-center gap-2 text-muted-foreground">
        <span className="tabular-nums" data-testid="fact-time">
          {fmtDateTimeNY(fact.createdAt)}
        </span>
        <Badge variant="outline" className="text-stage-vectordb" data-testid="fact-chunks">
          {plural(fact.chunks, 'chunk')}
        </Badge>
        <span className="truncate font-mono text-[10px]">{fact.key}</span>
      </div>
    </li>
  );
}
