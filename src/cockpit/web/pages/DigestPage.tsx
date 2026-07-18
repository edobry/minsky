/**
 * DigestPage — the Tier-2 cross-session digest (mt#2869).
 *
 * "What happened across the fleet today" — the temporal complement to the
 * live-state supervision surfaces (home radiator, workstreams spine). Groups
 * a calendar day's system events per workstream and renders each as a
 * Tier-1-shaped summary: what happened (count rollup), what you need to know
 * (exceptions only), where it stands (latest status) — everything else one
 * deeplink away. Pull-only by design: the ambient-cockpit push filter is
 * unshipped, so this surface is the RFC's pre-authorized pull fallback.
 *
 * Derivation lives in `../lib/digest.ts` (pure, unit-tested); this file is
 * fetch + render only.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { entityToPath } from "../lib/entity-codec";
import {
  buildDigest,
  dayWindow,
  summarizeCounts,
  FLEET_GROUP_KEY,
  type DigestEventRow,
  type DigestGroup,
} from "../lib/digest";

/** Generous day cap — a busy fleet day runs well past the activity feed's 100 default. */
const DAY_EVENT_LIMIT = 500;

async function fetchDayEvents(since: string, until: string): Promise<DigestEventRow[]> {
  const params = new URLSearchParams({ since, until, limit: String(DAY_EVENT_LIMIT) });
  const res = await fetch(`/api/activity?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`GET /api/activity failed: ${res.status}`);
  }
  const body = (await res.json()) as { events?: DigestEventRow[] };
  return body.events ?? [];
}

function useDayDigest(dayOffset: number) {
  const { since, until } = dayWindow(dayOffset);
  return useQuery({
    queryKey: ["digest", since, until],
    queryFn: () => fetchDayEvents(since, until),
    // Today's digest keeps up with the fleet; past days are settled history.
    refetchInterval: dayOffset === 0 ? 60_000 : false,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    select: buildDigest,
  });
}

function dayLabel(offset: number): string {
  if (offset === 0) return "Today";
  if (offset === 1) return "Yesterday";
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function GroupCard({ group }: { group: DigestGroup }) {
  const summary = summarizeCounts(group.counts);
  const isFleet = group.key === FLEET_GROUP_KEY;

  return (
    <div className="rounded border border-border bg-card/50 px-3 py-2" data-testid="digest-group">
      <div className="flex items-center gap-2">
        {isFleet ? (
          <span className="text-sm font-medium text-muted-foreground">Fleet / unattributed</span>
        ) : (
          <Link
            to={entityToPath("task", group.taskId ?? "")}
            className="font-mono text-sm text-foreground hover:text-signal-cyan transition-colors"
          >
            {group.taskId}
          </Link>
        )}
        {group.latestStatus && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground">
            {group.latestStatus}
          </span>
        )}
        {group.prNumbers.map((pr) => (
          <Link
            key={pr}
            to={entityToPath("changeset", String(pr))}
            className="font-mono text-xs text-muted-foreground hover:text-signal-cyan transition-colors"
          >
            #{pr}
          </Link>
        ))}
        <span className="ml-auto text-xs tabular-nums text-subtle">
          {group.eventCount} event{group.eventCount === 1 ? "" : "s"}
        </span>
      </div>

      {group.title && (
        <div className="mt-0.5 text-sm text-muted-foreground truncate">{group.title}</div>
      )}

      {summary && <div className="mt-1 text-xs text-muted-foreground">{summary}</div>}

      {group.exceptions.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5" data-testid="digest-exceptions">
          {group.exceptions.map((e, i) => (
            <li key={`${e.eventType}-${i}`} className="text-xs text-warn-amber">
              {e.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DigestBody({ dayOffset }: { dayOffset: number }) {
  const query = useDayDigest(dayOffset);

  if (query.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading digest…</p>;
  }
  if (query.isError) {
    return (
      <p className="text-sm text-warn-amber" data-testid="digest-error">
        Digest unavailable — {query.error instanceof Error ? query.error.message : "fetch failed"}
      </p>
    );
  }

  const groups = query.data ?? [];
  if (groups.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="digest-empty">
        No recorded fleet activity for {dayLabel(dayOffset).toLowerCase()}.
      </p>
    );
  }

  const workstreams = groups.filter((g) => g.key !== FLEET_GROUP_KEY);
  const totalExceptions = groups.reduce((n, g) => n + g.exceptions.length, 0);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground" data-testid="digest-headline">
        {workstreams.length} workstream{workstreams.length === 1 ? "" : "s"} active ·{" "}
        {groups.reduce((n, g) => n + g.counts.prsMerged, 0)} PRs merged ·{" "}
        {totalExceptions === 0 ? "no exceptions" : `${totalExceptions} exception${totalExceptions === 1 ? "" : "s"}`}
      </p>
      {groups.map((g) => (
        <GroupCard key={g.key} group={g} />
      ))}
    </div>
  );
}

export function DigestPage() {
  const [dayOffset, setDayOffset] = useState(0);

  return (
    <div className="p-4 flex flex-col gap-4 max-w-4xl mx-auto w-full">
      <div className="flex items-center gap-2">
        <h1 className="text-sm font-semibold text-foreground">Digest</h1>
        <span className="text-xs text-muted-foreground">— {dayLabel(dayOffset)}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setDayOffset((d) => d + 1)}
            className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted/60 transition-colors"
            aria-label="Previous day"
          >
            ←
          </button>
          <button
            type="button"
            onClick={() => setDayOffset((d) => Math.max(0, d - 1))}
            disabled={dayOffset === 0}
            className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted/60 transition-colors disabled:opacity-40"
            aria-label="Next day"
          >
            →
          </button>
        </div>
      </div>

      <ErrorBoundary id="digest">
        <DigestBody dayOffset={dayOffset} />
      </ErrorBoundary>
    </div>
  );
}
