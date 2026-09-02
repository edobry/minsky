/**
 * ProtectionPage — the OPERATOR rendering of the interceptor corpus (mt#4287,
 * phase 6 of mt#3754, the last one).
 *
 * The same substrate `/interceptors` reads, re-rendered for Eugene-as-user
 * rather than Eugene-as-maintainer. mem#802 is the governing record: a customer
 * pays for the shifted outcome distribution, not for maintaining the shifting
 * machinery, so this surface answers "what is protecting me, and what did it
 * charge me" and carries NO threshold, no false-positive rate, no lifecycle
 * vocabulary, and no flip/tune/keep affordance. It is read-only by design, not
 * by omission — preference expression is a WRITE and is owned by mt#3644 /
 * mt#3633.
 *
 * Four rendering choices are load-bearing and were derived via
 * `/product-thinking` rather than inherited from dashboard convention. A later
 * pass that "tidies" any of them back toward a conventional table is a
 * regression, so each is pinned by a test:
 *
 * 1. **All-working collapses to ONE calm line.** There is no grid of green
 *    chips. An all-green grid is the inventory anti-pattern and it trains the
 *    eye to skip the row where the anomaly will eventually appear. Per-class
 *    health renders only for a class that is NOT working.
 * 2. **Rows are failure CLASSES, keyed by the operator question.** The class is
 *    the axis a human thinks in; the interceptor is an operand.
 * 3. **No interceptor NAMES appear anywhere on this surface.** mem#802 bans
 *    detector names from the operator's vocabulary alongside thresholds and FP
 *    rates. Counts are fine; names are not. This is stronger than the term list
 *    and is asserted separately.
 * 4. **Order is degraded-first, then cost descending** — never alphabetical and
 *    never by check count, both of which are inventory orderings.
 *
 * ROUTE NAME IS A PLACEHOLDER. `/protection`, the page title, and the noun
 * "check" are customer-facing naming, which is principal-reserved
 * (`principal-context.mdc §Decisions Eugene reserves`); an ask carries the
 * decision and this ships on a candidate rather than blocking on it (SC7).
 *
 * @see packages/domain/src/guard-events/protection-summary.ts — the whole derivation
 * @see src/cockpit/web/pages/InterceptorsPage.tsx — the maintainer surface this diverges from
 * @see mt#3754 §"Two audiences, one data model" — the split
 */
import { useMemo } from "react";
import { InstanceScopeCue } from "../components/InstanceScopeCue";
import { useInterceptors } from "../hooks/useInterceptors";
import { useInterceptorAggregates } from "../hooks/useInterceptorAggregates";
import {
  deriveProtectionSummary,
  type ProtectionClassSummary,
  type ProtectionHealth,
  type ProtectionSummary,
} from "@minsky/domain/guard-events/protection-summary";
import { formatOperatorDuration, pluralize } from "../lib/protection-format";

/**
 * Operator-facing copy for classes whose authored question is maintainer-plane.
 *
 * Ten of the eleven classes carry a `question` that is already clean operator
 * vocabulary and is used verbatim from the catalog. `blind-enforcement` is the
 * exception: its question ("What tells me the guards themselves are still
 * working?") and its `failure` prose ("a calibration log past its review
 * window") are both written for the maintainer, and the second would fail this
 * surface's own vocabulary test.
 *
 * Overriding here rather than filtering keeps the two planes' copy separate at
 * the source — a filter would leave the maintainer sentence one refactor away
 * from reaching the operator.
 */
const OPERATOR_QUESTION_OVERRIDES: Record<string, string> = {
  "blind-enforcement": "What makes sure the protection itself is still working?",
};

/** The maintainer `failure` prose is never rendered here — only this layer is. */
function operatorQuestion(cls: ProtectionClassSummary): string {
  return OPERATOR_QUESTION_OVERRIDES[cls.classId] ?? cls.question;
}

function HealthBanner({ health }: { health: ProtectionSummary["health"] }) {
  if (health.kind === "degraded") {
    return (
      <p
        className="text-[12px] font-mono text-destructive border border-destructive/40 rounded px-2 py-1.5 m-0"
        data-testid="protection-health-degraded"
      >
        {pluralize(health.degradedCount, "check")} of {health.totalChecks} not working right now.
        Whatever those cover is not being caught.
      </p>
    );
  }
  // Two indeterminate facts, rendered as two sentences and, when both hold, both
  // (mt#4605). The COUNTS drive this, not `kind` — a snapshot can carry both at
  // once, and the single `unknown` sentence this replaces named only the
  // transient cause. On 2026-08-25 that told the operator its history "wasn't
  // available on the last refresh" while 81 of 149 checks had no history to be
  // unavailable: a banner that cannot clear, wearing the wording of one that will.
  if (health.sourceUnavailableCount > 0 || health.neverVerifiedCount > 0) {
    return (
      <div className="text-[12px] font-mono text-warn-amber border border-warn-amber/40 rounded px-2 py-1.5 flex flex-col gap-1">
        {health.sourceUnavailableCount > 0 ? (
          <p className="m-0" data-testid="protection-health-source-unavailable">
            {pluralize(health.sourceUnavailableCount, "check")} of {health.totalChecks}{" "}
            couldn&apos;t be read on the last refresh — that history wasn&apos;t available.
          </p>
        ) : null}
        {health.neverVerifiedCount > 0 ? (
          <p className="m-0" data-testid="protection-health-never-verified">
            {pluralize(health.neverVerifiedCount, "check")} of {health.totalChecks} have never been
            verified — nothing has ever tested that they fire, and refreshing won&apos;t change
            that.
          </p>
        ) : null}
        <p className="m-0">This is not the same as everything being fine.</p>
      </div>
    );
  }
  // The calm line. One sentence, no chrome, no grid — see the module note.
  return (
    <p
      className="text-[12px] font-mono text-muted-foreground m-0"
      data-testid="protection-health-working"
    >
      All {health.totalChecks} checks working.
    </p>
  );
}

function Figure({
  value,
  label,
  hint,
  testId,
}: {
  value: string;
  label: string;
  hint?: string;
  testId: string;
}) {
  return (
    <div className="flex flex-col gap-0.5" data-testid={testId}>
      <span className="text-lg font-mono tabular-nums leading-none">{value}</span>
      <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-[0.06em]">
        {label}
      </span>
      {hint ? <span className="text-[9px] font-mono text-muted-foreground/70">{hint}</span> : null}
    </div>
  );
}

function ClassRow({ cls }: { cls: ProtectionClassSummary }) {
  const { ledger } = cls;
  return (
    <li
      className="border-t border-border py-2.5 first:border-t-0"
      data-testid="protection-class-row"
      data-class-id={cls.classId}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12px] font-mono">{operatorQuestion(cls)}</span>
        <span className="text-[10px] font-mono text-muted-foreground shrink-0 tabular-nums">
          {pluralize(cls.checkCount, "check")}
        </span>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1 text-[10px] font-mono text-muted-foreground tabular-nums">
        {/* A quiet class gets a SENTENCE, not `stopped 0  flagged 0` (AT2).
            Zeros are the honest number and the wrong rendering: three of them
            in a row read as an empty state or a broken feed, when what they
            actually mean is the good outcome — nothing came up. The time still
            renders beside it, because a check that cost you something while
            catching nothing is exactly what the cost column is for. */}
        {ledger.interruptions === 0 ? (
          <span data-testid="protection-class-quiet">Nothing needed stopping here.</span>
        ) : (
          <>
            <span>
              stopped <span className="text-foreground">{ledger.stopped.toLocaleString()}</span>
            </span>
            <span>
              flagged <span className="text-foreground">{ledger.flagged.toLocaleString()}</span>
            </span>
          </>
        )}
        <span>
          {/* A null total is "never measured", NOT zero — the two mean opposite
              things and the snapshot already distinguishes them. */}
          time{" "}
          <span className="text-foreground">
            {ledger.timeMs === null ? "not measured" : formatOperatorDuration(ledger.timeMs)}
          </span>
          {ledger.timeMs !== null && ledger.unmeasuredFires > 0 ? (
            // The denominator, per mt#3754 SC6: a cost figure without the count
            // it was measured over is plausible rather than traceable.
            <span className="text-muted-foreground/70">
              {" "}
              (over {ledger.measuredFires.toLocaleString()} of{" "}
              {(ledger.measuredFires + ledger.unmeasuredFires).toLocaleString()})
            </span>
          ) : null}
        </span>
      </div>

      {/* Health renders ONLY when this class is not simply working — choice 1. */}
      {cls.health === "degraded" ? (
        <p className="text-[10px] font-mono text-destructive mt-1 m-0">
          {pluralize(cls.degradedCount, "check")} here not working.
        </p>
      ) : null}
      {cls.sourceUnavailableCount > 0 ? (
        <p className="text-[10px] font-mono text-warn-amber mt-1 m-0">
          {pluralize(cls.sourceUnavailableCount, "check")} here couldn&apos;t be read on the last
          refresh.
        </p>
      ) : null}
      {/* Muted, not amber, and the colour carries meaning rather than emphasis:
          amber is a LIVE problem (a read failed just now), and a standing gap is
          not one. Rendered amber this line lands on nearly every row — measured
          on the live corpus, 8 of 11 classes — which turns the page's alarm
          colour into its background texture and re-creates choice 1's
          all-green-grid failure from the other direction. The corpus banner
          above already states the ratio once, loudly. */}
      {cls.neverVerifiedCount > 0 ? (
        <p className="text-[10px] font-mono text-muted-foreground mt-1 m-0">
          {pluralize(cls.neverVerifiedCount, "check")} here have never been verified.
        </p>
      ) : null}
    </li>
  );
}

export function ProtectionPage() {
  const { data, isLoading, isError } = useInterceptors();
  const { data: aggregates } = useInterceptorAggregates();

  const snapshot = aggregates?.status === "ready" ? aggregates.snapshot : null;

  const summary = useMemo(() => {
    if (!data || !snapshot) return null;
    const questions: Record<string, string> = {};
    for (const [id, def] of Object.entries(data.failureClasses)) questions[id] = def.question;
    return deriveProtectionSummary(
      snapshot,
      data.entries.map((e) => ({ guardName: e.guardName, failureClasses: e.failureClasses })),
      questions
    );
  }, [data, snapshot]);

  return (
    <div className="p-4 w-full max-w-3xl mx-auto" data-testid="protection-page">
      <header className="mb-3">
        <h1 className="text-sm font-mono font-semibold tracking-[0.04em] m-0">
          WHAT&apos;S PROTECTING YOU
        </h1>
        <InstanceScopeCue className="mt-1" />
        <p className="text-[11px] font-mono text-muted-foreground mt-1">
          What Minsky&apos;s checks caught for you, and what they charged you in interruptions and
          time.
        </p>
      </header>

      {isError ? (
        <p className="text-[12px] font-mono text-destructive" data-testid="protection-error">
          Couldn&apos;t load this. Nothing here is a claim about whether the checks are working.
        </p>
      ) : null}

      {!isError && (isLoading || !summary) ? (
        // Honest over lively: no skeleton implying figures are on their way and
        // no zeros standing in for unknowns.
        <p className="text-[12px] font-mono text-muted-foreground" data-testid="protection-pending">
          Working out what the checks did — the numbers aren&apos;t in yet.
        </p>
      ) : null}

      {summary ? (
        <>
          <div className="mb-3">
            <HealthBanner health={summary.health} />
          </div>

          <div
            className="flex flex-wrap gap-x-8 gap-y-3 border border-border rounded px-3 py-3 mb-4"
            data-testid="protection-totals"
          >
            <Figure
              testId="protection-total-stopped"
              value={summary.totals.stopped.toLocaleString()}
              label="stopped"
              hint="things the checks blocked"
            />
            <Figure
              testId="protection-total-flagged"
              value={summary.totals.flagged.toLocaleString()}
              label="flagged"
              hint="raised without blocking"
            />
            <Figure
              testId="protection-total-time"
              value={
                summary.totals.timeMs === null
                  ? "not measured"
                  : formatOperatorDuration(summary.totals.timeMs)
              }
              label="your time"
              hint={
                summary.totals.timeMs === null
                  ? undefined
                  : `over ${summary.totals.measuredFires.toLocaleString()} measured`
              }
            />
            <Figure
              testId="protection-total-checks"
              value={summary.totals.checkCount.toLocaleString()}
              label="checks in place"
            />
          </div>

          {/* Two things a reader would otherwise have to reverse-engineer, and
              one of them looks like a bug: the per-row times sum to MORE than
              the total above, because a check covering three of these is one
              check in the total and three rows here. Saying so costs a line and
              turns an apparent arithmetic error into a fact about coverage.

              The ordering sentence names INTERRUPTIONS specifically rather than
              "cost", because time is a visible column that varies
              independently — a row with less time can sit above one with more,
              and a vaguer word would read as contradicting the column. */}
          <p className="text-[10px] font-mono text-muted-foreground/70 mb-2 m-0">
            Last {summary.windowDays} days. Ordered by how often they interrupted you, with anything
            not working first. A check can cover more than one of these, so the rows overlap — the
            totals above count each check once.
          </p>

          <ul className="list-none p-0 m-0" data-testid="protection-classes">
            {summary.classes.map((cls) => (
              <ClassRow key={cls.classId} cls={cls} />
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

export type { ProtectionHealth };
