/**
 * MemoryDetail content (mt#2150; re-framed mt#2410).
 *
 * Originally a fixed slide-in drawer over MemoriesPage; mt#2410 retired the
 * overlay in favor of the URL-addressable entity-tab pattern — MemoryPage
 * (/memory/:id) hosts MemoryDetailBody, and lineage/similar navigation is
 * URL navigation supplied by the host via `onNavigate`.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";
import { cn } from "../lib/utils";
import { Prose } from "../components/Prose";
import { EntityRef } from "../components/EntityRef";
import { useEntityIndex } from "../lib/use-entity-index";
import type { MemoryRecord, MemoryType } from "@minsky/domain/memory/types";
import type { AssociationType } from "@minsky/domain/memory/associations";
import type { RoutableEntityType } from "../lib/entity-codec";

/**
 * ADR-012's association vocabulary, declared LOCALLY rather than imported
 * from `@minsky/domain/memory/associations` at runtime: that module is
 * flagged by `custom/no-node-import-in-cockpit-web` (mt#3239) as reaching a
 * Node-only dependency transitively, so only its TYPE (`AssociationType`,
 * above) can cross into the browser bundle. This mirrors the same
 * declared-locally convention `MemoriesList.tsx` already uses for
 * server-only widget payload shapes — see that file's own docblock.
 *
 * ADR-012 fixes the canonical target-ID form per association type (tasks
 * `mt#NNNN`, PRs `PR#NNNN`, sessions a full UUID, rules a filename, skills a
 * bare name); the mt#4763 gate verdict (p) requires rendering each type
 * through the EXISTING `minsky://` entity codec using that declared form
 * rather than inventing a display mapping. Only the codec's own routable
 * types can become a real link — `rule`/`skill`/`transcript` have no cockpit
 * detail route (`entity-codec.ts`'s `ROUTABLE_ENTITY_TYPES`), so those stay
 * plain monospace text below, same as an unknown association key.
 */
const ASSOCIATION_ROUTABLE_KIND: Partial<Record<AssociationType, RoutableEntityType>> = {
  tracksTask: "task",
  relatedTask: "task",
  informsAsk: "ask",
  extractedFromSession: "session",
  citedInReview: "changeset",
  // originatesRule / originatesSkill / extractedFromTranscript have no
  // routable cockpit entity type — omitted, so they fall through to plain
  // monospace rendering below.
};

function isKnownAssociationType(key: string): key is AssociationType {
  return Object.hasOwn(ASSOCIATION_ROUTABLE_KIND, key) || key in ASSOCIATION_SEMANTICS;
}

/** Hover text only (`dt`'s `title`) — the full ADR-012 semantics table, duplicated locally for the same reason as above. */
const ASSOCIATION_SEMANTICS: Partial<Record<AssociationType, string>> = {
  tracksTask: "This memory is a bridge that retires when the named task ships",
  relatedTask: "This memory is related to (but not bridged on) the named task",
  originatesRule: "This memory originated the named rule file",
  originatesSkill: "This memory originated the named skill",
  informsAsk: "This memory was cited as evidence for the named ask",
  extractedFromSession: "This memory was extracted from the named session",
  extractedFromTranscript: "This memory was extracted from a specific transcript turn",
  citedInReview: "This memory was cited in a PR review",
};

/** ADR-012's PR target form is `PR#NNNN`; the changeset route id is the bare number. */
function prAssociationToChangesetId(value: string): string {
  return value.startsWith("PR#") ? value.slice("PR#".length) : value;
}

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
  const entityIndex = useEntityIndex();

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
                <EntityRef type="session" id={record.sourceSessionId} className="text-[10px]">
                  {record.sourceSessionId.slice(0, 8)}…
                </EntityRef>
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

      {/* Tags — clickable everywhere they render (mt#4763 success criterion):
          each tag navigates to the `/memories` facet-filtered view rather
          than just displaying inert text. */}
      {record.tags.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Tags
          </h3>
          <div className="flex flex-wrap gap-1">
            {record.tags.map((tag) => (
              <Link
                key={tag}
                to={`/memories?mem_f_tags=${encodeURIComponent(tag)}`}
                title={tag}
                aria-label={`Filter by ${tag}`}
                className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground text-[11px] hover:bg-primary/20 hover:text-primary transition-colors"
              >
                {tag}
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Associations — rendered through the SAME minsky:// entity codec as
          every other cockpit deeplink, per ADR-012's declared target-ID form
          for each association type (mt#4763 gate verdict (p)): tasks and
          asks route on their id directly, PRs route via the changeset
          codec (bare PR number), sessions route on the full UUID. A type
          with no routable target kind (rule/skill/transcript) or an
          unrecognized key renders as plain monospace, same as before. */}
      {Object.keys(record.associations).length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Associations
          </h3>
          <dl>
            {Object.entries(record.associations).map(([type, targets]) => {
              const routableType = isKnownAssociationType(type)
                ? ASSOCIATION_ROUTABLE_KIND[type]
                : undefined;
              const semantics = isKnownAssociationType(type)
                ? ASSOCIATION_SEMANTICS[type]
                : undefined;
              return (
                <div
                  key={type}
                  className="flex items-start gap-2 py-1 border-b border-border/50 last:border-0 text-xs"
                >
                  <dt className="text-muted-foreground flex-shrink-0" title={semantics}>
                    {type}
                  </dt>
                  <dd className="flex flex-wrap gap-1">
                    {targets.map((t) =>
                      routableType ? (
                        <EntityRef
                          key={t}
                          type={routableType}
                          id={routableType === "changeset" ? prAssociationToChangesetId(t) : t}
                          className="text-[10px]"
                        >
                          {t}
                        </EntityRef>
                      ) : (
                        <span
                          key={t}
                          className="font-mono bg-muted px-1 py-0.5 rounded text-[10px]"
                        >
                          {t}
                        </span>
                      )
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>
      )}

      {/* Content */}
      <section>
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
          Content
        </h3>
        <Prose
          entityIndex={entityIndex}
          className="max-h-64 overflow-y-auto rounded border border-border/50 bg-muted/30 p-3"
        >
          {record.content}
        </Prose>
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
    // Params go through fetchWidgetData's params argument — embedding them in
    // the id segment misses the widget route and returns the SPA fallback (mt#2443).
    queryFn: () => fetchWidgetData("memories-detail", { id: memoryId }),
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
