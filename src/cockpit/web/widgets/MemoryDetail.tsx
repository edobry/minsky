/**
 * MemoryDetail content (mt#2150; re-framed mt#2410).
 *
 * Originally a fixed slide-in drawer over MemoriesPage; mt#2410 retired the
 * overlay in favor of the URL-addressable entity-tab pattern — MemoryPage
 * (/memory/:id) hosts MemoryDetailBody, and lineage/similar navigation is
 * URL navigation supplied by the host via `onNavigate`.
 */
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";
import { cn } from "../lib/utils";
import type { MemoryRecord, MemoryType } from "@minsky/domain/memory/types";

interface MemorySearchResult {
  record: MemoryRecord;
  score: number;
}

export interface MemoriesDetailPayload {
  record: MemoryRecord;
  lineage: MemoryRecord[];
  lineageTruncated: boolean;
  similar: MemorySearchResult[];
}

const TYPE_BADGE: Record<MemoryType, string> = {
  user: "bg-primary/20 text-primary",
  feedback: "bg-amber-500/20 text-amber-500",
  project: "bg-emerald-500/20 text-emerald-500",
  reference: "bg-muted text-muted-foreground",
};

function relativeTime(date: Date | string): string {
  const d = date instanceof Date ? date : new Date(date);
  const diffMs = Date.now() - d.getTime();
  if (isNaN(diffMs)) return "—";
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-2 py-1 border-b border-border/50 last:border-0 text-xs">
      <dt className="text-muted-foreground flex-shrink-0">{label}</dt>
      <dd className="text-right break-all">{value}</dd>
    </div>
  );
}

export function MemoryDetailContent({
  payload,
  onNavigate,
}: {
  payload: MemoriesDetailPayload;
  onNavigate?: (id: string) => void;
}) {
  const { record, lineage, lineageTruncated, similar } = payload;

  return (
    <div className="space-y-4 overflow-y-auto flex-1">
      {/* Metadata */}
      <section>
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
          Metadata
        </h3>
        <dl className="space-y-0">
          <MetaRow
            label="Type"
            value={
              <span
                className={cn("px-1.5 py-0.5 rounded text-xs capitalize", TYPE_BADGE[record.type])}
              >
                {record.type}
              </span>
            }
          />
          <MetaRow label="Scope" value={record.scope} />
          {record.projectId && (
            <MetaRow
              label="Project"
              value={<span className="font-mono">{record.projectId}</span>}
            />
          )}
          <MetaRow label="Created" value={relativeTime(record.createdAt)} />
          <MetaRow label="Updated" value={relativeTime(record.updatedAt)} />
          {record.lastAccessedAt && (
            <MetaRow label="Last accessed" value={relativeTime(record.lastAccessedAt)} />
          )}
          <MetaRow label="Access count" value={record.accessCount} />
          {record.sourceSessionId && (
            <MetaRow
              label="Source session"
              value={
                <span className="font-mono text-[10px]">{record.sourceSessionId.slice(0, 8)}…</span>
              }
            />
          )}
          {record.supersededBy && (
            <MetaRow
              label="Superseded by"
              value={
                onNavigate ? (
                  <button
                    onClick={() => onNavigate(record.supersededBy!)}
                    className="font-mono text-[10px] text-primary hover:underline"
                  >
                    {record.supersededBy.slice(0, 8)}…
                  </button>
                ) : (
                  <span className="font-mono text-[10px]">{record.supersededBy.slice(0, 8)}…</span>
                )
              }
            />
          )}
        </dl>
      </section>

      {/* Tags */}
      {record.tags.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Tags
          </h3>
          <div className="flex flex-wrap gap-1">
            {record.tags.map((tag) => (
              <span
                key={tag}
                className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground text-[11px]"
              >
                {tag}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* Associations */}
      {Object.keys(record.associations).length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Associations
          </h3>
          <dl>
            {Object.entries(record.associations).map(([type, targets]) => (
              <div
                key={type}
                className="flex items-start gap-2 py-1 border-b border-border/50 last:border-0 text-xs"
              >
                <dt className="text-muted-foreground flex-shrink-0">{type}</dt>
                <dd className="flex flex-wrap gap-1">
                  {targets.map((t) => (
                    <span key={t} className="font-mono bg-muted px-1 py-0.5 rounded text-[10px]">
                      {t}
                    </span>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {/* Content */}
      <section>
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
          Content
        </h3>
        <pre className="text-xs font-mono bg-muted/30 border border-border/50 rounded p-3 whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
          {record.content}
        </pre>
      </section>

      {/* Lineage */}
      {lineage.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Supersession Chain
            {lineageTruncated && <span className="ml-1 text-muted-foreground">(truncated)</span>}
          </h3>
          <ol className="space-y-1">
            {lineage.map((rec, idx) => (
              <li key={rec.id} className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground w-4 flex-shrink-0">{idx + 1}.</span>
                {onNavigate ? (
                  <button
                    onClick={() => onNavigate(rec.id)}
                    className={cn(
                      "truncate text-left",
                      rec.id === record.id
                        ? "font-semibold text-foreground"
                        : "text-primary hover:underline"
                    )}
                  >
                    {rec.name}
                  </button>
                ) : (
                  <span className={cn("truncate", rec.id === record.id && "font-semibold")}>
                    {rec.name}
                  </span>
                )}
                <span className="text-muted-foreground flex-shrink-0">
                  {relativeTime(rec.createdAt)}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* Similar memories */}
      {similar.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Similar Memories
          </h3>
          <ul className="space-y-1">
            {similar.map(({ record: sim, score }) => (
              <li key={sim.id} className="flex items-center gap-2 text-xs">
                {onNavigate ? (
                  <button
                    onClick={() => onNavigate(sim.id)}
                    className="truncate text-left text-primary hover:underline flex-1 min-w-0"
                  >
                    {sim.name}
                  </button>
                ) : (
                  <span className="truncate flex-1 min-w-0">{sim.name}</span>
                )}
                <span className="text-muted-foreground flex-shrink-0 tabular-nums">
                  {(score * 100).toFixed(0)}%
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-fetching body (no overlay chrome) — hosted by MemoryPage (/memory/:id)
// ---------------------------------------------------------------------------

export function MemoryDetailBody({
  memoryId,
  onNavigate,
}: {
  memoryId: string;
  onNavigate?: (id: string) => void;
}) {
  const query = useQuery<WidgetData, Error>({
    queryKey: ["widget", "memories-detail", memoryId],
    queryFn: () => fetchWidgetData(`memories-detail?id=${encodeURIComponent(memoryId)}`),
    staleTime: 30_000,
  });

  if (query.isPending) {
    return <p className="text-xs text-muted-foreground">Loading…</p>;
  }
  if (query.isError) {
    return <p className="text-xs text-destructive">Failed to load: {query.error.message}</p>;
  }
  if (query.data.state !== "ok") {
    return (
      <p className="text-xs text-muted-foreground">
        {query.data.state === "degraded" ? query.data.reason : "Memory detail unavailable."}
      </p>
    );
  }
  return (
    <MemoryDetailContent
      payload={query.data.payload as MemoriesDetailPayload}
      onNavigate={onNavigate}
    />
  );
}
