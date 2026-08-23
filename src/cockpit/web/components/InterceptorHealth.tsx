/**
 * Health + cost rendering for the `/interceptors` surface (mt#4057 slice 2).
 *
 * Both the catalog and the detail route render health through these, so the
 * two pages cannot drift into showing the same state differently.
 *
 * EVERY STATE GETS ITS OWN COLOR AND ITS OWN WORD. mt#3754 SC4 asks for the
 * quiet states to be "visually distinct"; the cases that actually get confused
 * are dormant (never fired, verified working) vs deterrent (fired before, quiet
 * now) vs canary-unavailable (we could not check this refresh). Color alone
 * would not carry that, so each chip states its evidence beside the word — a
 * broken-since date, a last-verified date, a last-fire date.
 *
 * @see @minsky/domain/guard-events/interceptor-state — the derivation
 * @see mt#4057 §State derivation
 */
import type {
  AttentionCounts,
  InterceptorCost,
  InterceptorState,
  InterceptorStateKind,
} from "@minsky/domain/guard-events/interceptor-state";
import { formatMs } from "../hooks/useInterceptorAggregates";

const STATE_LABELS: Record<InterceptorStateKind, string> = {
  broken: "BROKEN",
  "never-verified": "NEVER VERIFIED",
  active: "ACTIVE",
  deterrent: "DETERRENT",
  dormant: "DORMANT",
  "canary-unavailable": "NO CANARY DATA",
};

const STATE_CLASSES: Record<InterceptorStateKind, string> = {
  broken: "text-warn-red border-warn-red/50",
  "never-verified": "text-warn-amber border-warn-amber/50",
  active: "text-liveness-healthy border-liveness-healthy/50",
  deterrent: "text-liveness-idle border-liveness-idle/50",
  dormant: "text-liveness-stale border-liveness-stale/50",
  "canary-unavailable": "text-muted-foreground border-dashed border-muted-foreground/50",
};

const STATE_TITLES: Record<InterceptorStateKind, string> = {
  broken: "Its canary failed — this interceptor does not currently work.",
  "never-verified": "No canary has ever run for this name, so nothing establishes that it works.",
  active: "Canary passing, and it has fired inside the window.",
  deterrent: "Canary passing, quiet in the window, but it has fired before.",
  dormant: "Canary passing, and it has never fired — its condition has not arisen.",
  "canary-unavailable":
    "The canary source failed on the last refresh. This is not the same as never-verified.",
};

function shortDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * The evidence line beside the word — what makes the chip auditable rather
 * than decorative.
 */
function stateEvidence(state: InterceptorState): string | null {
  switch (state.kind) {
    case "broken": {
      const since = shortDate(state.brokenSinceAt);
      return since ? `since ${since}` : "broken since: not recorded";
    }
    case "deterrent": {
      const last = shortDate(state.lastFireAt);
      return last ? `last fired ${last}` : `${state.lifetimeFires} lifetime fires`;
    }
    case "dormant":
      return "never fired";
    case "active":
      return `${state.windowFires} in window`;
    case "never-verified":
      return null;
    case "canary-unavailable":
      return "last refresh";
  }
}

export function InterceptorStateChip({ state }: { state: InterceptorState }) {
  const evidence = stateEvidence(state);
  return (
    <span
      className={`inline-flex items-baseline gap-1 rounded border px-1 py-px text-[9px] font-mono ${STATE_CLASSES[state.kind]}`}
      title={STATE_TITLES[state.kind]}
      data-testid={`interceptor-state-${state.kind}`}
    >
      {STATE_LABELS[state.kind]}
      {evidence && <span className="opacity-70">{evidence}</span>}
    </span>
  );
}

/**
 * The cost figure, always with its denominator.
 *
 * Only fire-log records carrying a `duration_ms` reach the aggregate, so the
 * measured-fire count is part of the figure rather than a footnote: a total
 * over 12 of 400 fires means something different from a total over all 400,
 * and rendering only the total would let a reader assume the second.
 */
export function InterceptorCostFigure({ cost }: { cost: InterceptorCost | null }) {
  if (!cost) {
    return (
      <span className="text-[9px] font-mono text-muted-foreground/70" data-testid="interceptor-cost-unmeasured">
        no timing recorded
      </span>
    );
  }
  return (
    <span className="text-[9px] font-mono text-muted-foreground" data-testid="interceptor-cost">
      {formatMs(cost.totalMs)} over {cost.measuredFires} measured
      {cost.unmeasuredFires > 0 && (
        <span
          className="opacity-70"
          title={`${cost.unmeasuredFires} fires in the window carried no duration and are outside this figure.`}
        >
          {" "}
          (+{cost.unmeasuredFires} untimed)
        </span>
      )}
    </span>
  );
}

function AttentionCount({
  label,
  value,
  testId,
  emphasis,
}: {
  label: string;
  value: number | null;
  testId: string;
  emphasis: string;
}) {
  // A failed source renders as an em dash with its own title, never as 0 —
  // "0 broken" and "we could not check" are opposite messages.
  const unavailable = value === null;
  return (
    <span data-testid={testId} className="whitespace-nowrap">
      <strong className={unavailable ? "text-muted-foreground" : emphasis}>
        {unavailable ? "—" : value}
      </strong>{" "}
      <span title={unavailable ? "The source for this count failed on the last refresh." : undefined}>
        {label}
      </span>
    </span>
  );
}

/**
 * The above-the-fold attention row (mt#3754 SC1): what needs attention, before
 * any inventory.
 */
export function InterceptorAttentionBar({
  counts,
  computedAt,
  sourceFailures,
  windowDays,
}: {
  counts: AttentionCounts;
  computedAt: string;
  sourceFailures: string[];
  windowDays: number;
}) {
  return (
    <div
      className="mb-3 rounded border border-border/60 p-2"
      data-testid="interceptors-attention-bar"
    >
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] font-mono">
        <AttentionCount
          label="broken"
          value={counts.broken}
          testId="attention-broken"
          emphasis="text-warn-red"
        />
        <AttentionCount
          label="review-due"
          value={counts.reviewDue}
          testId="attention-review-due"
          emphasis="text-warn-amber"
        />
        <AttentionCount
          label="graduation-overdue"
          value={counts.graduationOverdue}
          testId="attention-graduation-overdue"
          emphasis="text-warn-amber"
        />
        <AttentionCount
          label="never-verified"
          value={counts.neverVerified}
          testId="attention-never-verified"
          emphasis="text-warn-amber"
        />
      </div>
      <p className="mt-1 text-[9px] font-mono text-muted-foreground/70">
        Counts and costs over the last {windowDays} days, computed{" "}
        {new Date(computedAt).toISOString().replace("T", " ").slice(0, 16)}Z.
      </p>
      {sourceFailures.length > 0 && (
        <p
          className="mt-1 text-[10px] font-mono text-warn-amber"
          data-testid="interceptors-source-failures"
        >
          Sources unavailable on the last refresh: {sourceFailures.join(", ")}. Figures drawn from
          them read as unavailable, not as zero.
        </p>
      )}
    </div>
  );
}

/**
 * Shown while the sweeper has not completed its first refresh.
 *
 * Says which columns are missing and why, rather than rendering them empty —
 * the same discipline slice 1's scope note carried, applied to a transient
 * state instead of a permanent one.
 */
export function InterceptorHealthPending({ testId }: { testId: string }) {
  return (
    <p className="text-[10px] font-mono text-muted-foreground/70" data-testid={testId}>
      Health and cost are still computing — the corpus rollup runs off-request and has not completed
      a pass since this cockpit started. They are absent here, not zero.
    </p>
  );
}
