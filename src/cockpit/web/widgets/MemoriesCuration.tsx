/**
 * Curation worklists + growth panel for `/memories` (mt#4767).
 *
 * Replaces `<MemoryStats>`, whose five numbers (a total, a four-way type
 * breakdown, a 7-day count, a superseded count, a top-3-accessed list) were
 * all true and none actionable — none of them answered whether the corpus was
 * healthy, and none of them was a thing you could click and then do something
 * about.
 *
 * Every count here is a QUEUE HEAD: clicking it navigates the table below to
 * exactly that population, where mt#4766's write actions (retag, edit,
 * supersede, delete, and their bulk forms) already live. That composition is
 * the point — a worklist that only reported its size would be the same
 * vanity number in a different shape.
 *
 * The one exception is Duplicates, which is read-only by design: mt#1619 owns
 * the dedup key decision and the cleanup, so this surface links out rather
 * than acting. See `memories-duplicates.ts` for why it is a page view rather
 * than a table filter.
 */
import { useQuery } from "@tanstack/react-query";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";
import { useProject } from "../lib/project-context";
import { cn } from "../lib/utils";
import {
  applyWorklist,
  isWorklistActive,
  useReactiveSearch,
  type WorklistId,
} from "../lib/memories-url";

interface CurationWorklist {
  id: WorklistId;
  count: number;
}

interface GrowthBucket {
  weekStart: string;
  total: number;
  handoff: number;
  retrospective: number;
  other: number;
}

interface MemoriesCurationPayload {
  worklists: CurationWorklist[];
  duplicateGroups: number;
  coldDays: number;
  growth: GrowthBucket[];
}

/**
 * Display metadata per worklist. `hint` is what the operator is expected to DO
 * about it — a worklist whose remedy isn't obvious is a statistic again.
 */
const WORKLIST_META: Record<WorklistId, { label: string; hint: string }> = {
  untagged: { label: "Untagged", hint: "no tags — nothing will retrieve these by facet" },
  neverRead: { label: "Never read", hint: "never retrieved since it was written" },
  cold: { label: "Cold", hint: "read once, not since" },
  duplicates: { label: "Duplicates", hint: "byte-identical to another record" },
  superseded: { label: "Superseded", hint: "already replaced — kept for lineage" },
};

const WORKLIST_ORDER: WorklistId[] = [
  "untagged",
  "neverRead",
  "cold",
  "duplicates",
  "superseded",
];

function WorklistTile({
  id,
  count,
  active,
  subtitle,
  onClick,
}: {
  id: WorklistId;
  count: number;
  active: boolean;
  subtitle: string;
  onClick: () => void;
}) {
  const meta = WORKLIST_META[id];
  // A zero worklist is not clickable: navigating to an empty list is a dead
  // end, and greying it out says "nothing to do here" without hiding that the
  // population is tracked.
  const empty = count === 0;
  return (
    <button
      type="button"
      disabled={empty}
      onClick={onClick}
      title={meta.hint}
      data-testid={`worklist-${id}`}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex flex-col items-start gap-0.5 rounded-md border px-2.5 py-2 text-left transition-colors",
        empty
          ? "border-border bg-card/40 text-muted-foreground cursor-default"
          : active
            ? "border-primary bg-primary/10 text-foreground"
            : "border-border bg-card hover:border-primary/50 hover:bg-primary/5 text-foreground"
      )}
    >
      <span className="text-lg font-semibold tabular-nums leading-none">{count}</span>
      <span className="text-[11px] font-medium">{meta.label}</span>
      <span className="text-[10px] text-muted-foreground leading-tight">{subtitle}</span>
    </button>
  );
}

/**
 * Eight weeks of creations, cohort-split, as proportional bars.
 *
 * Hand-rolled divs rather than a charting library: this is five values a week
 * over eight weeks, the cockpit has no charting dependency today, and adding
 * one is a decision with its own open ask (ask#10299, on the reviewer-cost
 * page). A stacked bar of three segments does not justify pre-empting it.
 */
function GrowthPanel({ buckets }: { buckets: GrowthBucket[] }) {
  if (buckets.length === 0) return null;
  const max = Math.max(...buckets.map((b) => b.total), 1);

  // The handoff share is the one number this panel exists for (mt#4767): the
  // corpus's growth is majority-handoff by new volume, and that composition is
  // an operational property — every record here is a candidate for injection
  // into agent context. Rendered as a figure, not just as bar proportion,
  // because "legible at a glance" is the requirement and reading a ratio off
  // stacked bars is not that.
  const windowTotal = buckets.reduce((sum, b) => sum + b.total, 0);
  const windowHandoff = buckets.reduce((sum, b) => sum + b.handoff, 0);
  const handoffPct = windowTotal > 0 ? Math.round((windowHandoff / windowTotal) * 100) : 0;

  return (
    <div className="mt-3" data-testid="growth-panel">
      <div className="flex items-baseline justify-between mb-1.5 gap-2">
        <h3 className="text-[11px] font-medium text-foreground">
          Created per week
          <span className="ml-2 font-normal text-muted-foreground" data-testid="handoff-share">
            {windowTotal} in {buckets.length} weeks — {handoffPct}% handoffs
          </span>
        </h3>
        <span className="text-[10px] text-muted-foreground flex-shrink-0">
          handoff / retrospective / other
        </span>
      </div>
      <div className="flex items-end gap-1 h-20" role="img" aria-label="Memories created per week, split by cohort">
        {buckets.map((b) => {
          const pct = (n: number) => `${(n / max) * 100}%`;
          return (
            <div
              key={b.weekStart}
              className="flex-1 flex flex-col justify-end h-full min-w-0"
              title={`Week of ${b.weekStart}: ${b.total} created — ${b.handoff} handoff, ${b.retrospective} retrospective, ${b.other} other`}
              data-testid={`growth-week-${b.weekStart}`}
            >
              {/* Semantic tokens at three opacities, not three raw palette
                  hues: docs/design-system.md §5.2 blesses raw emerald/amber
                  ONLY for healthy/warning status indicators, and a growth
                  panel is a data series, not a status. The ordering is the
                  message — handoffs are the most saturated because their
                  share is the number this panel exists to make legible (53%
                  of August's creations). */}
              <div className="flex flex-col justify-end h-full">
                <div className="bg-primary/80" style={{ height: pct(b.handoff) }} />
                <div className="bg-primary/35" style={{ height: pct(b.retrospective) }} />
                <div className="bg-muted-foreground/25" style={{ height: pct(b.other) }} />
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex gap-1 mt-1">
        {buckets.map((b) => (
          <span
            key={b.weekStart}
            className="flex-1 text-center text-[9px] text-muted-foreground tabular-nums min-w-0 truncate"
          >
            {b.weekStart.slice(5)}
          </span>
        ))}
      </div>
    </div>
  );
}

export function MemoriesCuration() {
  const search = useReactiveSearch();
  const { queryParam: projectParam } = useProject();

  const query = useQuery<WidgetData, Error>({
    queryKey: ["widget", "memories-curation", projectParam?.project ?? ""],
    queryFn: () => fetchWidgetData("memories-curation", { ...projectParam }),
    staleTime: 30_000,
  });

  if (query.isLoading || !query.data) {
    return (
      <div className="text-xs text-muted-foreground py-2" data-testid="curation-loading">
        Reading corpus health…
      </div>
    );
  }

  // Explicit failure, never a rendered zero (mt#2757: this corner of the
  // cockpit showed healthy-looking zeros for five weeks while every query
  // underneath was failing). A curation panel is exactly the surface where a
  // zero reads as good news, so it must never be the error state.
  if (query.isError || query.data.state === "degraded") {
    const reason = query.isError
      ? query.error.message
      : (query.data as { reason: string }).reason;
    return (
      <div
        role="alert"
        data-testid="curation-error"
        className="rounded-md border border-warn-red/40 bg-warn-red/10 px-2.5 py-2 text-xs"
      >
        <span className="font-medium text-warn-red">Corpus health unavailable</span>
        <span className="text-muted-foreground"> — {reason}</span>
      </div>
    );
  }

  const payload = query.data.payload as MemoriesCurationPayload;
  const byId = new Map(payload.worklists.map((w) => [w.id, w.count]));

  function subtitleFor(id: WorklistId): string {
    if (id === "cold") return `not read in ${payload.coldDays}d`;
    if (id === "duplicates") return `in ${payload.duplicateGroups} groups`;
    return WORKLIST_META[id].hint.split(" — ")[0] ?? "";
  }

  return (
    <section data-testid="memories-curation">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-1.5">
        {WORKLIST_ORDER.map((id) => (
          <WorklistTile
            key={id}
            id={id}
            count={byId.get(id) ?? 0}
            active={isWorklistActive(search, id)}
            subtitle={subtitleFor(id)}
            onClick={() => applyWorklist(id, id === "cold" ? payload.coldDays : undefined)}
          />
        ))}
      </div>
      <GrowthPanel buckets={payload.growth} />
    </section>
  );
}
