/**
 * ReviewerCostPage — the "/reviewer/cost" route (mt#4557).
 *
 * Answers "where is the reviewer's money going?": a 30-day stacked-by-
 * token-class spend chart with a $/review line overlaid, a per-config
 * cohort table (mt#4569's per-PR-parity interleaved assignment makes this a
 * genuine controlled comparison — no confound caveat is rendered, per
 * mt#4557 SC2), a cap-pin share, and an outlier tail of the ten most
 * expensive reviews in the window.
 *
 * Data source: useReviewerCost -> GET /api/widget/reviewer-cost/data ->
 * ../../widgets/reviewer-cost.ts.
 *
 * CURRENT STATE (2026-08-25): the widget is blocked on mt#4546's
 * review_timing accessor (ask#10301) and always resolves a degraded state,
 * so this page renders its error branch, not the "ok" branch below, until
 * that lands. The "ok" branch is written and tested against fabricated data
 * so the page is ready to light up the moment both mt#4546 (the accessor)
 * and the mt#4557 chart-library decision (ask#10299) resolve; until the
 * chart-library decision lands the chart section renders a data table
 * (still real numbers, just not the bar+line chart SC1 specifies).
 *
 * Quality is deliberately not shown here (spec's "Deferred, deliberately"):
 * the real quality measure lives in paired-eval-runner.ts's eval artifacts,
 * gated on mt#2991. A cost-only page invites ratcheting the model down
 * until quality craters silently, so the page says so rather than omitting
 * the concern.
 *
 * @see mt#4557 — this page
 * @see mt#4546 — the accessor this page must read through (blocked, ask#10301)
 * @see mt#4569 — the per-PR-parity assignment that makes the cohort split valid
 * @see ../../widgets/reviewer-cost.ts — payload shape + domain semantics
 */
import { Link } from "react-router-dom";
import { useReviewerCost, ReviewerCostNotYetAvailableError } from "../hooks/useReviewerCost";
import { relativeTime } from "../lib/format";
import type {
  ReviewerCostCohortRow,
  ReviewerCostDailyBucket,
  ReviewerCostOutlierEntry,
} from "../hooks/useReviewerCost";

function formatUsd(value: number | null): string {
  if (value === null) return "—";
  return `$${value.toFixed(4)}`;
}

function formatPct(value: number | null): string {
  if (value === null) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function formatFingerprint(fp: string | null): string {
  return fp ?? "unknown configuration";
}

// ---------------------------------------------------------------------------
// Sub-sections (each exported for direct testing against fabricated data)
// ---------------------------------------------------------------------------

/**
 * The primary SC1 view: 30-day spend by token class with a $/review line.
 * Renders as a compact data table until ask#10299 (chart-library-or-hand-roll)
 * resolves — real numbers, not yet the bar+line chart the spec specifies.
 */
export function DailySpendSection({ buckets }: { buckets: ReviewerCostDailyBucket[] }) {
  return (
    <section className="mb-4" data-testid="reviewer-cost-daily-spend">
      <h2 className="text-sm font-semibold text-foreground mb-1">
        Daily spend, 30 days, by token class
      </h2>
      <p className="text-xs text-muted-foreground mb-2">
        Chart rendering is pending a principal decision on charting approach (ask#10299) — shown
        as a table below in the meantime. Bars up with the $/review column flat means volume; the
        $/review column rising means a real unit regression.
      </p>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-xs" data-testid="reviewer-cost-daily-spend-table">
          <thead>
            <tr className="border-b border-border bg-card/60 text-left text-muted-foreground">
              <th className="px-2.5 py-1.5 font-normal">date</th>
              <th className="px-2.5 py-1.5 font-normal">uncached input</th>
              <th className="px-2.5 py-1.5 font-normal">cached input</th>
              <th className="px-2.5 py-1.5 font-normal">output (of which reasoning)</th>
              <th className="px-2.5 py-1.5 font-normal">reviews</th>
              <th className="px-2.5 py-1.5 font-normal">$/review</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => (
              <tr
                key={b.date}
                className="border-b border-border/50 last:border-0"
                data-testid={`reviewer-cost-daily-row-${b.date}`}
              >
                <td className="px-2.5 py-1.5 font-mono">{b.date}</td>
                <td className="px-2.5 py-1.5">{formatUsd(b.uncachedInputCostUsd)}</td>
                <td className="px-2.5 py-1.5">{formatUsd(b.cachedInputCostUsd)}</td>
                <td className="px-2.5 py-1.5">
                  {formatUsd(b.outputCostUsd)}{" "}
                  <span className="text-muted-foreground">
                    ({formatUsd(b.reasoningCostUsd)})
                  </span>
                </td>
                <td className="px-2.5 py-1.5">{b.reviewCount}</td>
                <td className="px-2.5 py-1.5 font-semibold">{formatUsd(b.costPerReviewUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** SC1's per-config cohort table. No confound caveat per SC2 — mt#4569's
 * per-PR-parity assignment makes this a genuine controlled comparison. */
export function CohortTableSection({ cohorts }: { cohorts: ReviewerCostCohortRow[] }) {
  return (
    <section className="mb-4" data-testid="reviewer-cost-cohorts">
      <h2 className="text-sm font-semibold text-foreground mb-1">Per-config cohort</h2>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-xs" data-testid="reviewer-cost-cohorts-table">
          <thead>
            <tr className="border-b border-border bg-card/60 text-left text-muted-foreground">
              <th className="px-2.5 py-1.5 font-normal">config</th>
              <th className="px-2.5 py-1.5 font-normal">reviews</th>
              <th className="px-2.5 py-1.5 font-normal">$/review (median)</th>
              <th className="px-2.5 py-1.5 font-normal">$/review (p90)</th>
              <th className="px-2.5 py-1.5 font-normal">cache-hit</th>
              <th className="px-2.5 py-1.5 font-normal">cap-pin share</th>
              <th className="px-2.5 py-1.5 font-normal">R1 / R&gt;=2</th>
            </tr>
          </thead>
          <tbody>
            {cohorts.map((c) => (
              <tr
                key={c.configFingerprint ?? "unknown"}
                className="border-b border-border/50 last:border-0"
                data-testid={`reviewer-cost-cohort-row-${c.configFingerprint ?? "unknown"}`}
              >
                <td className="px-2.5 py-1.5 font-mono">{formatFingerprint(c.configFingerprint)}</td>
                <td className="px-2.5 py-1.5">{c.reviewCount}</td>
                <td className="px-2.5 py-1.5">{formatUsd(c.costPerReviewMedianUsd)}</td>
                <td className="px-2.5 py-1.5">{formatUsd(c.costPerReviewP90Usd)}</td>
                <td className="px-2.5 py-1.5">{formatPct(c.cacheHitRatio)}</td>
                <td className="px-2.5 py-1.5">{formatPct(c.capPinShare)}</td>
                <td className="px-2.5 py-1.5">
                  {c.r1Count} / {c.r2PlusCount}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** SC1's cap-pin share — a single prominent number. */
export function CapPinShareTile({ share }: { share: number }) {
  return (
    <div
      className="rounded-md border border-border bg-card p-3 mb-4"
      data-testid="reviewer-cost-cap-pin-tile"
    >
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        Reviews pinned at the 10-round cap
      </div>
      <div className="text-lg font-semibold">{formatPct(share)}</div>
    </div>
  );
}

/** SC1's outlier tail: the ten most expensive reviews, each linking to its PR. */
export function OutlierTailSection({ entries }: { entries: ReviewerCostOutlierEntry[] }) {
  return (
    <section className="mb-4" data-testid="reviewer-cost-outliers">
      <h2 className="text-sm font-semibold text-foreground mb-1">Outlier tail</h2>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-xs" data-testid="reviewer-cost-outliers-table">
          <thead>
            <tr className="border-b border-border bg-card/60 text-left text-muted-foreground">
              <th className="px-2.5 py-1.5 font-normal">PR</th>
              <th className="px-2.5 py-1.5 font-normal">cost</th>
              <th className="px-2.5 py-1.5 font-normal">config</th>
              <th className="px-2.5 py-1.5 font-normal">when</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr
                key={e.reviewTimingId}
                className="border-b border-border/50 last:border-0"
                data-testid={`reviewer-cost-outlier-row-${e.reviewTimingId}`}
              >
                <td className="px-2.5 py-1.5 font-mono">
                  <Link to={`/changeset/${e.prNumber}`} className="text-primary hover:underline">
                    {e.prOwner}/{e.prRepo}#{e.prNumber}
                  </Link>
                </td>
                <td className="px-2.5 py-1.5 font-semibold">{formatUsd(e.costUsd)}</td>
                <td className="px-2.5 py-1.5 font-mono text-muted-foreground">
                  {formatFingerprint(e.configFingerprint)}
                </td>
                <td className="px-2.5 py-1.5" title={e.createdAt}>
                  {relativeTime(e.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ReviewerCostPage() {
  const { data, isLoading, isError, error } = useReviewerCost();

  return (
    <div className="p-4 w-full max-w-5xl mx-auto" data-testid="reviewer-cost-page">
      <nav
        className="flex items-center gap-1.5 text-xs text-muted-foreground mb-3"
        aria-label="Breadcrumb"
      >
        <span className="text-foreground">Reviewer</span>
        <span aria-hidden="true">/</span>
        <span className="text-foreground">Cost</span>
      </nav>

      <header className="mb-4">
        <h1 className="text-h1 font-semibold text-foreground m-0">Reviewer cost</h1>
        <p className="text-xs text-muted-foreground mt-1">
          Daily spend by token class, per-config cohorts, cap-pin share, and the outlier tail —
          from <code className="font-mono">review_timing</code>, read through{" "}
          <Link to="/tasks/mt%234546" className="hover:underline">
            mt#4546
          </Link>
          &apos;s accessor. Quality is not shown on this page yet — the real measure lives in
          eval artifacts gated on mt#2991; cost and quality are deliberately shown separately
          until that lands, not folded together.
        </p>
      </header>

      {isLoading && (
        <p className="text-sm text-muted-foreground" data-testid="reviewer-cost-loading">
          Loading…
        </p>
      )}

      {/* Two visually and semantically distinct branches for "no data" (mt#3348
          R1, reviewer-bot BLOCKING finding): a page that shows one generic red
          error for both "this feature isn't wired up yet" and "a live query
          just failed" gives an operator no way to tell the two apart. The
          KNOWN not-yet-wired case (mt#4546 unwired) renders a neutral notice;
          any OTHER error — including a genuine accessor failure once mt#4546
          lands — renders the urgent error panel. */}
      {isError && error instanceof ReviewerCostNotYetAvailableError && (
        <div
          className="rounded-md border border-border bg-card p-3 text-sm text-foreground"
          data-testid="reviewer-cost-not-yet-available"
        >
          <div className="font-semibold text-foreground mb-1">Not yet available</div>
          <div className="text-muted-foreground">{error.message}</div>
        </div>
      )}

      {isError && !(error instanceof ReviewerCostNotYetAvailableError) && (
        <div
          className="rounded-md border border-warn-red/40 bg-warn-red/10 p-3 text-sm text-foreground"
          role="alert"
          data-testid="reviewer-cost-error"
        >
          <div className="font-semibold text-warn-red mb-1">Data unavailable</div>
          <div>{error instanceof Error ? error.message : "Failed to load reviewer cost data."}</div>
        </div>
      )}

      {data?.status === "no-data" && (
        <p className="text-sm text-muted-foreground" data-testid="reviewer-cost-empty">
          No priced reviews recorded in this window.
        </p>
      )}

      {data?.status === "ok" && (
        <>
          <div
            className="text-[10px] font-mono text-muted-foreground mb-2"
            data-testid="reviewer-cost-window"
          >
            Window: {relativeTime(data.windowStart)} — {relativeTime(data.windowEnd)}
          </div>
          <DailySpendSection buckets={data.dailyBuckets} />
          <CapPinShareTile share={data.capPinShareOverall} />
          <CohortTableSection cohorts={data.cohorts} />
          <OutlierTailSection entries={data.outlierTail} />
        </>
      )}
    </div>
  );
}
