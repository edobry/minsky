/**
 * TriageBand — the home page's needs-me band (mt#2881).
 *
 * The radiator's top surface: every pending ask, ranked by display tier then
 * age (oldest first — age is accumulated attention debt), each row one click
 * from its decision (`/ask/:id`). This is GLANCE altitude (/product-thinking):
 * no inline respond affordances — those live on the /asks console.
 *
 * Tier discipline (ISA-18.2 via /product-thinking §audit): the 7-band
 * kind-priority ladder (P1–P7, AskDetail's KIND_PRIORITY — the ask-kind
 * taxonomy itself is mt#1034's and is NOT changed here) is collapsed to
 * THREE display tiers: high (P1–P2), medium (P3–P4), low (P5–P7). Two
 * queue-health signals render alongside the rows:
 *
 *   - Tier-distribution health: when the queue is large enough for the
 *     distribution to be meaningful (n ≥ MIN_N_FOR_DISTRIBUTION), a high-tier
 *     share above HIGH_SHARE_CEILING flags the TIERING as unhealthy — too
 *     much "urgent" devalues urgent (ISA-18.2's ~5/15/80 target).
 *   - Flood mode: above FLOOD_THRESHOLD pending items the list collapses to
 *     per-kind summary rows — a scrolling wall of items is unreadable at
 *     glance altitude; grouped counts are not.
 *
 * Data: GET /api/asks via the SAME ["asks"] query key AsksPage uses — one
 * cache serves the console and the radiator.
 */
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  fetchAsks,
  formatRelative,
  formatDeadlineRemaining,
  KIND_PRIORITY,
  type AskItem,
  type AsksListResponse,
} from "./AskDetail";

// ---------------------------------------------------------------------------
// Display tiers
// ---------------------------------------------------------------------------

export type DisplayTier = "high" | "medium" | "low";

const TIER_ORDER: Record<DisplayTier, number> = { high: 0, medium: 1, low: 2 };

/** Collapse the 7-band kind priority into the 3 display tiers. */
export function displayTier(ask: Pick<AskItem, "kind">): DisplayTier {
  const p = KIND_PRIORITY[ask.kind] ?? 7;
  if (p <= 2) return "high";
  if (p <= 4) return "medium";
  return "low";
}

/**
 * Display-tier badge colors (mt#2917 register pass). Per
 * docs/design-system.md §5.1's red-scarcity rule, a priority/tier badge is
 * classification, not an active alarm — never red, regardless of tier. The
 * mt#2914 audit found "high" rendering bg-destructive (red) at volume (a P2
 * kind collapsed into "high" on nearly every row); tiers now differentiate
 * by amber weight only, reserving red for a genuinely escalated ask
 * (deadline missed — see the isOverdue text-destructive treatment below,
 * which is unchanged and correct).
 */
const TIER_STYLES: Record<DisplayTier, { badge: string; label: string }> = {
  high: { badge: "bg-warn-amber text-background font-semibold", label: "high" },
  medium: { badge: "bg-warn-amber/35 text-foreground", label: "med" },
  low: { badge: "bg-muted text-muted-foreground", label: "low" },
};

/**
 * Queue sizes below this make tier-distribution percentages meaningless
 * (1 high ask in a queue of 6 is 17% but is not a tiering failure). ISA-18.2's
 * distribution target presumes volume; below the floor the check stays quiet.
 */
export const MIN_N_FOR_DISTRIBUTION = 10;

/** ISA-18.2 target: ~5% of items at the top tier. Above this, tiering itself is the anomaly. */
export const HIGH_SHARE_CEILING = 0.05;

/** Above this many pending items, collapse to per-kind summary rows (flood mode). */
export const FLOOD_THRESHOLD = 10;

/** Rank: display tier first, then oldest first within a tier. */
export function rankAsks(asks: AskItem[]): AskItem[] {
  return [...asks].sort((a, b) => {
    const tierDiff = TIER_ORDER[displayTier(a)] - TIER_ORDER[displayTier(b)];
    if (tierDiff !== 0) return tierDiff;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
}

export interface KindGroup {
  kind: string;
  tier: DisplayTier;
  count: number;
  oldestCreatedAt: string;
}

/** Flood-mode grouping: one summary row per kind, ranked like the rows. */
export function groupByKind(asks: AskItem[]): KindGroup[] {
  const groups = new Map<string, KindGroup>();
  for (const ask of asks) {
    const existing = groups.get(ask.kind);
    if (!existing) {
      groups.set(ask.kind, {
        kind: ask.kind,
        tier: displayTier(ask),
        count: 1,
        oldestCreatedAt: ask.createdAt,
      });
    } else {
      existing.count += 1;
      if (new Date(ask.createdAt) < new Date(existing.oldestCreatedAt)) {
        existing.oldestCreatedAt = ask.createdAt;
      }
    }
  }
  return [...groups.values()].sort((a, b) => {
    const tierDiff = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
    if (tierDiff !== 0) return tierDiff;
    return b.count - a.count;
  });
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function TierBadge({ tier }: { tier: DisplayTier }) {
  const s = TIER_STYLES[tier];
  return (
    <span
      className={`text-xs px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 w-10 text-center ${s.badge}`}
    >
      {s.label}
    </span>
  );
}

function TriageRow({ ask }: { ask: AskItem }) {
  const deadlineStr = formatDeadlineRemaining(ask.deadline);
  const isOverdue = deadlineStr === "overdue";
  return (
    <Link
      to={`/ask/${encodeURIComponent(ask.id)}`}
      className="flex items-center gap-2 rounded border border-border bg-card/50 px-2.5 py-1.5 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
    >
      <TierBadge tier={displayTier(ask)} />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-foreground truncate">{ask.title}</p>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs text-muted-foreground truncate">{ask.kind}</span>
          {ask.parentTaskId && (
            <span className="text-xs font-mono text-muted-foreground flex-shrink-0">
              {ask.parentTaskId}
            </span>
          )}
        </div>
      </div>
      {deadlineStr && (
        <span
          className={`text-xs flex-shrink-0 tabular-nums ${
            isOverdue ? "text-destructive font-medium" : "text-muted-foreground"
          }`}
        >
          {deadlineStr}
        </span>
      )}
      <span className="text-xs text-muted-foreground flex-shrink-0 tabular-nums">
        {formatRelative(ask.createdAt)}
      </span>
    </Link>
  );
}

function FloodRow({ group }: { group: KindGroup }) {
  return (
    <Link
      to="/asks"
      className="flex items-center gap-2 rounded border border-border bg-card/50 px-2.5 py-1.5 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
    >
      <TierBadge tier={group.tier} />
      <span className="flex-1 min-w-0 truncate text-xs font-medium text-foreground">
        {group.count} × {group.kind}
      </span>
      <span className="text-xs text-muted-foreground flex-shrink-0 tabular-nums">
        oldest {formatRelative(group.oldestCreatedAt)}
      </span>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Band
// ---------------------------------------------------------------------------

export function TriageBand() {
  const query = useQuery<AsksListResponse, Error>({
    queryKey: ["asks"],
    queryFn: fetchAsks,
    staleTime: 10_000,
    refetchInterval: 10_000,
  });

  if (query.isError) {
    return (
      <p className="text-sm text-destructive">Failed to load asks: {query.error.message}</p>
    );
  }
  if (query.isLoading || !query.data) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  const asks = query.data.asks ?? [];

  if (asks.length === 0) {
    // The desirable state — render it honestly and calmly, never filled with
    // receipts (/product-thinking: anomaly over inventory).
    return (
      <div className="py-4 text-center">
        <p className="text-sm font-medium text-foreground">Nothing needs you</p>
        <p className="mt-0.5 font-warm-mono italic text-xs text-muted-foreground">
          queue empty — no pending asks
        </p>
      </div>
    );
  }

  const ranked = rankAsks(asks);
  const highCount = ranked.filter((a) => displayTier(a) === "high").length;
  const highShare = highCount / ranked.length;
  const tieringUnhealthy =
    ranked.length >= MIN_N_FOR_DISTRIBUTION && highShare > HIGH_SHARE_CEILING;
  const flood = ranked.length > FLOOD_THRESHOLD;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Link
          to="/asks"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          {ranked.length} pending →
        </Link>
        {tieringUnhealthy && (
          <span
            className="rounded bg-warn-amber/30 px-1.5 py-0.5 text-xs text-foreground"
            title={`${highCount} of ${ranked.length} pending asks are top-tier (${Math.round(
              highShare * 100
            )}%). Above ~5%, "urgent" stops meaning urgent — re-tier or resolve (ISA-18.2 distribution discipline).`}
          >
            tiering: {Math.round(highShare * 100)}% high
          </span>
        )}
      </div>

      {flood
        ? groupByKind(ranked).map((g) => <FloodRow key={g.kind} group={g} />)
        : ranked.map((ask) => <TriageRow key={ask.id} ask={ask} />)}
    </div>
  );
}
