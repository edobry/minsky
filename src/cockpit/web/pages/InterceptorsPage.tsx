/**
 * InterceptorsPage — the `/interceptors` route (mt#4010 slice 1).
 *
 * The readable corpus: every DECLARED interceptor, grouped by stratum, with its
 * description, failure classes, provenance status and enumerated coverage gaps.
 * The route noun is fixed by ask#7119 (`docs/architecture/interceptors.md` §6).
 *
 * SLICE 1B (mt#4056) added the three axes — interception point, intervention
 * type, decision mechanism — as per-row chips and as facet filters, plus the
 * computed guard/detector/injector family filters. The two zero-family states
 * render as DIFFERENT markers; see `FamilyChips` for why that is the point of
 * the slice rather than a detail of it.
 *
 * SLICE 2 (mt#4057) added what slice 1 deliberately left absent: whether each
 * interceptor currently WORKS, what it costs, and the attention counts above
 * the fold. Two sources compose here — the build-time catalog artifact
 * (static) and the aggregates snapshot (live, sweeper-refreshed) — joined by
 * `guardName` in the client, since only the second one moves.
 *
 * The absence discipline slice 1 established did not go away with the scope
 * note it was written on: a figure whose SOURCE failed this refresh still
 * renders as unavailable rather than as zero, and the pending state before the
 * first rollup says so in copy. See `InterceptorHealth.tsx`.
 *
 * @see mt#4010 — slice 1 (the readable corpus)
 * @see mt#4056 — slice 1b (the axes + family filters)
 * @see mt#4057 — slice 2 (health, cost, attention counts)
 * @see src/cockpit/web/hooks/useInterceptors.ts — the static data source
 * @see src/cockpit/web/hooks/useInterceptorAggregates.ts — the live data source
 * @see src/cockpit/web/components/InterceptorFacets.tsx — the facet controls + axis chips
 * @see docs/architecture/interceptors.md — the ontology this renders
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  useInterceptors,
  COVERAGE_GAP_LABELS,
  STRATUM_LABELS,
  STRATUM_ORDER,
  type InterceptorEntry,
  type InterceptorStratum,
} from "../hooks/useInterceptors";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  AxisChips,
  InterceptorFacetBar,
  NO_FACETS,
  matchesFacets,
  type InterceptorFacets,
} from "../components/InterceptorFacets";
import {
  indexSnapshotRows,
  useInterceptorAggregates,
} from "../hooks/useInterceptorAggregates";
import {
  InterceptorAttentionBar,
  InterceptorCostFigure,
  InterceptorHealthPending,
  InterceptorStateChip,
} from "../components/InterceptorHealth";
import {
  computeAttentionCounts,
  deriveInterceptorCost,
  deriveInterceptorState,
} from "@minsky/domain/guard-events/interceptor-state";
import type { InterceptorAggregateRow } from "@minsky/domain/guard-events/aggregates";
import { LifecycleSpine } from "../components/LifecycleSpine";

const ALL_CLASSES = "__all__";

function FailureClassChips({ classes }: { classes: string[] }) {
  if (classes.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {classes.map((c) => (
        <span
          key={c}
          className="rounded bg-muted px-1 py-px text-[9px] font-mono text-muted-foreground"
        >
          {c}
        </span>
      ))}
    </span>
  );
}

/**
 * The health + cost cell.
 *
 * Three cases the reader must be able to tell apart, so each renders
 * differently: the aggregates are not loaded yet (nothing here — the page-level
 * note explains), the name has a row (state chip + cost), or the snapshot is
 * ready and this declared name is in NEITHER population. The third is a
 * finding about the catalog rather than about the interceptor.
 */
function HealthCell({
  aggregate,
  snapshotReady,
}: {
  aggregate: InterceptorAggregateRow | undefined;
  snapshotReady: boolean;
}) {
  if (!snapshotReady) return null;
  if (!aggregate) {
    return (
      <span
        className="text-[9px] font-mono text-warn-amber"
        title="This declared name appears in neither the fire log nor the aggregates snapshot's declared set."
        data-testid="interceptor-no-aggregate"
      >
        not in the aggregates snapshot
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-baseline gap-2">
      <InterceptorStateChip state={deriveInterceptorState(aggregate)} />
      <InterceptorCostFigure cost={deriveInterceptorCost(aggregate)} />
    </span>
  );
}

function EntryRow({
  entry,
  aggregate,
  snapshotReady,
}: {
  entry: InterceptorEntry;
  aggregate: InterceptorAggregateRow | undefined;
  snapshotReady: boolean;
}) {
  return (
    <li className="border-b border-border/40 py-2" data-testid="interceptor-row">
      <div className="flex items-baseline justify-between gap-3">
        <Link
          to={`/interceptors/${encodeURIComponent(entry.guardName)}`}
          className="font-mono text-[12px] text-primary hover:underline"
        >
          {entry.guardName}
        </Link>
        <FailureClassChips classes={entry.failureClasses} />
      </div>

      <div className="mt-1">
        <HealthCell aggregate={aggregate} snapshotReady={snapshotReady} />
      </div>

      {entry.undescribed ? (
        // The explicit gap marker, never a blank cell: a name the oracle knows
        // and nobody has described is a finding, and rendering it as empty
        // space is exactly the absence-vs-declaration conflation to avoid.
        <p className="mt-0.5 text-[11px] text-warn-amber" data-testid="interceptor-undescribed">
          No authored description — this name is declared but undescribed.
        </p>
      ) : (
        <p className="mt-0.5 text-[11px] text-muted-foreground">{entry.description}</p>
      )}

      <div className="mt-1 text-[9px] font-mono">
        <AxisChips entry={entry} />
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-2 text-[9px] font-mono text-muted-foreground/70">
        {entry.provenanceStatus === "declaration-only" && (
          <span title="No source module implements this — the pointer is a declaration site.">
            declaration-only
          </span>
        )}
        {entry.provenanceStatus === "none" && <span>no provenance</span>}
        {!entry.registered && <span>not in the dispatcher registry</span>}
        {entry.subject === "system" && (
          <span title="Classifies other interceptors rather than the trajectory.">
            subject: system
          </span>
        )}
        {entry.coverageGaps.map((g) => (
          <span key={g}>{COVERAGE_GAP_LABELS[g]}</span>
        ))}
      </div>
    </li>
  );
}

export function InterceptorsPage() {
  const { data, isLoading, isError } = useInterceptors();
  // A SECOND query, not a blocking dependency of the first: the corpus is
  // readable while the rollup is still computing, and slice 1's whole point was
  // that it is worth reading on its own.
  const { data: aggregates } = useInterceptorAggregates();
  const [query, setQuery] = useState("");
  const [failureClass, setFailureClass] = useState<string>(ALL_CLASSES);
  const [facets, setFacets] = useState<InterceptorFacets>(NO_FACETS);

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.entries.filter((e) => {
      if (failureClass !== ALL_CLASSES && !e.failureClasses.includes(failureClass)) return false;
      if (!matchesFacets(e, facets)) return false;
      if (q === "") return true;
      return (
        e.guardName.toLowerCase().includes(q) ||
        (e.description ?? "").toLowerCase().includes(q) ||
        e.failureClasses.some((c) => c.includes(q))
      );
    });
  }, [data, query, failureClass, facets]);

  const grouped = useMemo(() => {
    const byStratum = new Map<InterceptorStratum | "unknown", InterceptorEntry[]>();
    for (const e of filtered) {
      const key = e.stratum ?? "unknown";
      const list = byStratum.get(key);
      if (list) list.push(e);
      else byStratum.set(key, [e]);
    }
    return byStratum;
  }, [filtered]);

  const aggregateRows = useMemo(() => indexSnapshotRows(aggregates), [aggregates]);
  const snapshot = aggregates?.status === "ready" ? aggregates.snapshot : null;

  const undescribedCount = data?.entries.filter((e) => e.undescribed).length ?? 0;

  // The family-STATE counts partition the population; the per-family counts do
  // NOT (an entity can be both a guard and a detector, ontology amendment (a)),
  // so only this breakdown is presented as a sum.
  const familyStates = useMemo(() => {
    const entries = data?.entries ?? [];
    return {
      classified: entries.filter((e) => e.familyState === "classified").length,
      outOfModel: entries.filter((e) => e.familyState === "out-of-model").length,
      unclassified: entries.filter((e) => e.familyState === "unclassified").length,
    };
  }, [data]);

  return (
    <div className="p-4 w-full max-w-4xl mx-auto" data-testid="interceptors-page">
      <header className="mb-4">
        <h1 className="text-sm font-mono font-semibold tracking-[0.04em] m-0">
          INTERCEPTORS — the declared corpus
        </h1>
        <p className="text-[11px] font-mono text-muted-foreground mt-1">
          Every interceptor the system declares — dispatcher registry, standalone hooks, pre-commit
          steps, plus the retired and fixture names the append-only fire log still carries. What each
          one catches, and what metadata it is missing.
        </p>
      </header>

      {/* Above the fold, and ABOVE the inventory's own loading state: what needs
          attention is the reason to open this page (mt#3712, mt#3754 SC1), so it
          does not wait on the alphabetical corpus to arrive. */}
      {snapshot ? (
        <InterceptorAttentionBar
          counts={computeAttentionCounts(snapshot)}
          computedAt={snapshot.computedAt}
          sourceFailures={snapshot.sourceFailures}
          windowDays={snapshot.windowDays}
        />
      ) : (
        <div className="mb-3">
          <InterceptorHealthPending testId="interceptors-health-pending" />
        </div>
      )}

      {isLoading && (
        <p className="text-sm text-muted-foreground" data-testid="interceptors-loading">
          Loading…
        </p>
      )}

      {isError && (
        <p className="text-sm text-warn-amber" data-testid="interceptors-error">
          Failed to load the interceptor catalog.
        </p>
      )}

      {data && (
        <>
          {/* The spatial overview (mt#4011): where each interceptor applies on
              one turn's trajectory. Reads the same two sources as the rows
              below — placement from the static catalog, size/health from the
              aggregates snapshot — so it degrades exactly as they do. */}
          <LifecycleSpine
            entries={data.entries}
            aggregateRows={aggregateRows}
            windowDays={snapshot?.windowDays ?? null}
          />

          <div
            className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono text-muted-foreground mb-3"
            data-testid="interceptors-summary"
          >
            <span>
              <strong className="text-foreground">{data.population}</strong> declared
            </span>
            <span>
              <strong className="text-foreground">{undescribedCount}</strong> undescribed
            </span>
            <span>
              <strong className="text-foreground">{Object.keys(data.failureClasses).length}</strong>{" "}
              failure classes
            </span>
            <span data-testid="interceptors-family-state-summary">
              <strong className="text-foreground">{familyStates.classified}</strong> in a family ·{" "}
              <strong className="text-foreground">{familyStates.outOfModel}</strong> outside the
              model · <strong className="text-warn-amber">{familyStates.unclassified}</strong>{" "}
              unclassified
            </span>
          </div>

          {/* Divergence between the two independent declarations is a finding, so
              it renders as one — and is absent entirely when there is none,
              rather than as a reassuring zero. */}
          {(data.divergence.declaredButNotDescribed.length > 0 ||
            data.divergence.describedButNotDeclared.length > 0) && (
            <div
              className="mb-3 rounded border border-warn-amber/40 p-2 text-[11px] font-mono text-warn-amber"
              data-testid="interceptors-divergence"
            >
              The oracle and the descriptions disagree about the population.
              {data.divergence.declaredButNotDescribed.length > 0 && (
                <div>Declared, not described: {data.divergence.declaredButNotDescribed.join(", ")}</div>
              )}
              {data.divergence.describedButNotDeclared.length > 0 && (
                <div>Described, not declared: {data.divergence.describedButNotDeclared.join(", ")}</div>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 mb-3">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by name or description…"
              aria-label="Filter interceptors"
              data-testid="interceptors-filter"
              className="flex-1 min-w-[12rem] rounded border border-border bg-background px-2 py-1 text-[11px] font-mono"
            />
            {/* The `Select` primitive, not a native `<select>`: a native one
                keeps `appearance: auto` and paints the platform widget, which
                under the tray's WKWebView is a macOS aqua pop-up in a
                dark-mode-first UI (mt#3347). */}
            <Select value={failureClass} onValueChange={setFailureClass}>
              <SelectTrigger
                aria-label="Filter by failure class"
                data-testid="interceptors-class-filter"
                className="h-7 font-mono"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_CLASSES}>All failure classes</SelectItem>
                {Object.keys(data.failureClasses).map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="mb-3">
            <InterceptorFacetBar facets={facets} onChange={setFacets} />
          </div>

          {failureClass !== ALL_CLASSES && data.failureClasses[failureClass] && (
            <p className="mb-3 text-[11px] text-muted-foreground" data-testid="interceptors-class-definition">
              {data.failureClasses[failureClass].failure}
            </p>
          )}

          {filtered.length === 0 && (
            <p className="text-[11px] font-mono text-muted-foreground" data-testid="interceptors-empty">
              No interceptor matches this filter.
            </p>
          )}

          {STRATUM_ORDER.filter((s) => (grouped.get(s)?.length ?? 0) > 0).map((stratum) => (
            <section key={stratum} className="mb-5" data-testid={`interceptors-group-${stratum}`}>
              <h2 className="text-[11px] font-mono font-semibold tracking-[0.04em] text-muted-foreground m-0">
                {STRATUM_LABELS[stratum].toUpperCase()} ({grouped.get(stratum)?.length ?? 0})
              </h2>
              <ul className="list-none p-0 m-0 mt-1">
                {grouped.get(stratum)?.map((e) => (
                  <EntryRow
                    key={e.guardName}
                    entry={e}
                    aggregate={aggregateRows?.get(e.guardName)}
                    snapshotReady={aggregateRows !== null}
                  />
                ))}
              </ul>
            </section>
          ))}

          {(grouped.get("unknown")?.length ?? 0) > 0 && (
            <section className="mb-5" data-testid="interceptors-group-unknown">
              <h2 className="text-[11px] font-mono font-semibold tracking-[0.04em] text-warn-amber m-0">
                NO DECLARED STRATUM ({grouped.get("unknown")?.length ?? 0})
              </h2>
              <ul className="list-none p-0 m-0 mt-1">
                {grouped.get("unknown")?.map((e) => (
                  <EntryRow
                    key={e.guardName}
                    entry={e}
                    aggregate={aggregateRows?.get(e.guardName)}
                    snapshotReady={aggregateRows !== null}
                  />
                ))}
              </ul>
            </section>
          )}

          {/* mt#4010's scope note lived here and is GONE (mt#4057 SC5), not
              edited around: it existed to mark the health-and-cost gap honestly
              while that gap existed, and leaving a softened version would keep
              telling the reader a question is unanswered that this page now
              answers. */}
          {snapshot && (
            <p
              className="mt-6 border-t border-border/40 pt-3 text-[10px] font-mono text-muted-foreground/70"
              data-testid="interceptors-population-note"
            >
              Health and cost cover {snapshot.population} interceptors the fire log has recorded
              plus {snapshot.declaredOnlyRows.length} declared names it never has. A declared name
              in neither is marked on its row rather than left blank.
            </p>
          )}
        </>
      )}
    </div>
  );
}
