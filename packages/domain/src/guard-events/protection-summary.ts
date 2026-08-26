/**
 * The OPERATOR rendering's derivation (mt#4287, phase 6 of mt#3754).
 *
 * mt#3754 §"Two audiences, one data model" splits the interceptor corpus into a
 * vendor view (Eugene-as-maintainer: health lifecycle, cost, calibration state,
 * disposition) and an operator view (Eugene-as-user: what is protecting me,
 * what did it cost me). mem#802 is the governing record — a customer pays for
 * the shifted outcome distribution, not for maintaining the shifting machinery
 * — and it bans threshold, FP-rate and DETECTOR-NAME vocabulary from the
 * operator's side of that split.
 *
 * This module is the operator side's whole derivation. Three properties are
 * load-bearing and are what the tests actually pin:
 *
 * 1. **It re-reads, it does not re-define.** Every figure composes
 *    `deriveInterceptorState` / `deriveInterceptorCost` over the same
 *    `InterceptorAggregatesSnapshot` the maintainer surface reads. mt#3754 SC6
 *    forbids a second definition of any rendered number, and a second
 *    definition here would be invisible: both surfaces would look right and
 *    disagree.
 *
 * 2. **The unit is the FAILURE CLASS, not the interceptor.** The class is the
 *    axis a human thinks in ("what stops me merging something unreviewed?");
 *    the interceptor is an operand. Its name never leaves this module — see
 *    the `names` field's note.
 *
 * 3. **Totals dedupe; classes do not.** An interceptor carries one or more
 *    failure classes (152 assignments over 135 entries as of 2026-08-19), so
 *    summing the per-class rows OVERCOUNTS the corpus. `totals` is computed
 *    over the distinct name set for exactly that reason.
 *
 * Pure and fully injected — the snapshot, the entries, and the class copy all
 * arrive as arguments. No module reaches for a collaborator, so nothing here
 * needs a spy to observe (`testing-standards.mdc §Testable Design`).
 *
 * @see packages/domain/src/guard-events/interceptor-state.ts — the derivations this composes
 * @see packages/domain/src/guard-events/aggregates.ts — the snapshot shape
 * @see mem#802 — the calibration-ownership principle this implements
 */
import type { InterceptorAggregateRow, InterceptorAggregatesSnapshot } from "./aggregates";
import {
  allAggregateRows,
  deriveInterceptorCost,
  deriveInterceptorState,
} from "./interceptor-state";

/**
 * What the operator is told about whether a thing is working.
 *
 * Four states, not the six `InterceptorStateKind` carries: the lifecycle
 * distinctions the maintainer needs (deterrent vs dormant vs active) are the
 * machinery, and mem#802 puts the machinery on the vendor's side. What survives
 * the translation is the part the operator can act on.
 *
 * Neither indeterminate state is folded into `working`. An interceptor whose
 * status could not be determined has not been shown to work, and rendering it
 * as working is the failure mode mt#3754 AT2 and the mt#2076 five-week blind
 * spot are both about.
 *
 * THE TWO INDETERMINATE STATES ARE SEPARATE, AND THAT SEPARATION IS THE POINT
 * (mt#4605). They were one `unknown` kind until 2026-08-25, which meant the
 * surface had exactly one sentence for two facts with opposite remedies:
 *
 * - `source-unavailable` — the verdict could not be READ this refresh. Transient.
 *   The next refresh may well clear it, and nothing about the checks changed.
 * - `never-verified` — the check has no verdict to read, because nothing has ever
 *   tested it. PERMANENT until someone writes that test; no refresh will ever
 *   change it.
 *
 * Both were rendered with the transient sentence, so on 2026-08-25 the page told
 * the operator its history "wasn't available on the last refresh" while 81 of 149
 * checks simply had no history to be unavailable — and an amber banner that never
 * clears is one the operator learns to stop reading, which is the same blind spot
 * from the other direction.
 */
export type ProtectionHealth = "working" | "degraded" | "never-verified" | "source-unavailable";

/** Per-interceptor status, before it is folded up to the class. */
type CheckStatus = "working" | "not-working" | "unconfirmed" | "source-unavailable";

/**
 * A fold of many `CheckStatus` values into what a banner can say.
 *
 * The COUNTS, not `kind`, are what a renderer should branch on when a set can
 * hold both indeterminate states at once: `kind` names one state, and a mix is
 * two facts. `kind` exists for the one-line case (ordering, a single label);
 * anything rendering prose reads the counts and may print both sentences.
 */
export interface ProtectionHealthCounts {
  /**
   * The single state a one-line summary would name.
   *
   * Precedence: `degraded` (something is known broken) → `source-unavailable`
   * (a live read failed — actionable NOW) → `never-verified` (a standing gap) →
   * `working`. Transient-over-permanent is deliberate: a source failure is
   * today's news and may be an incident, while the standing gap was there
   * yesterday and will be there tomorrow.
   */
  kind: ProtectionHealth;
  /** Checks the canary says are BROKEN. */
  degradedCount: number;
  /** Checks with no verdict ever — nothing has tested them. Permanent until one is written. */
  neverVerifiedCount: number;
  /** Checks whose verdict could not be read this refresh. Transient. */
  sourceUnavailableCount: number;
}

function checkStatus(row: InterceptorAggregateRow): CheckStatus {
  const state = deriveInterceptorState(row);
  switch (state.kind) {
    case "broken":
      return "not-working";
    case "never-verified":
      return "unconfirmed";
    case "canary-unavailable":
      return "source-unavailable";
    // `active` / `deterrent` / `dormant` all mean the same thing to an
    // operator: the check is in place and confirmed working. Whether it has
    // fired recently is a maintainer question about deterrence, not an
    // operator question about protection.
    default:
      return "working";
  }
}

/**
 * Fold per-check statuses into a banner-shaped verdict.
 *
 * Every count is reported on EVERY return, including the ones the chosen `kind`
 * does not name — that is what lets a caller render a mix as two facts instead
 * of picking one and dropping the other (mt#4605). The old shape returned
 * `degradedCount` only, so the two indeterminate states arrived at the renderer
 * indistinguishable and uncountable.
 */
function foldHealth(statuses: readonly CheckStatus[]): ProtectionHealthCounts {
  const degradedCount = statuses.filter((s) => s === "not-working").length;
  const neverVerifiedCount = statuses.filter((s) => s === "unconfirmed").length;
  const sourceUnavailableCount = statuses.filter((s) => s === "source-unavailable").length;
  const counts = { degradedCount, neverVerifiedCount, sourceUnavailableCount };
  if (degradedCount > 0) return { kind: "degraded", ...counts };
  if (sourceUnavailableCount > 0) return { kind: "source-unavailable", ...counts };
  if (neverVerifiedCount > 0) return { kind: "never-verified", ...counts };
  return { kind: "working", ...counts };
}

/**
 * What the enforcement did, and what it charged, over the snapshot's window.
 *
 * `stopped` and `flagged` are the two decisions an operator actually
 * experiences; `allow` and `other` are silent and are counted in neither.
 * `interruptions` is their sum and is the operator-facing cost figure —
 * NOT the fire count, most of which the operator never saw.
 */
export interface ProtectionLedger {
  /** Denials — the enforcement stopped something. */
  stopped: number;
  /** Warnings — the enforcement flagged something without stopping it. */
  flagged: number;
  /** `stopped + flagged`: the fires that actually reached the operator. */
  interruptions: number;
  /**
   * Wall-clock spent, and its denominator.
   *
   * `timeMs` is null when NO fire in the set carried a duration — a measured
   * absence, distinct from a measured zero. `measuredFires` is the number of
   * fires the figure was computed over and is always rendered beside it:
   * per mt#3754 SC6 a cost figure without its denominator is plausible rather
   * than traceable, since a guard can have 400 fires and 12 measured ones.
   */
  timeMs: number | null;
  measuredFires: number;
  unmeasuredFires: number;
}

export interface ProtectionClassSummary {
  /** The taxonomy key. Rendered nowhere — it is the join key and the test id. */
  classId: string;
  /** The operator-facing heading. */
  question: string;
  /** How many interceptors carry this class. A COUNT, never names. */
  checkCount: number;
  ledger: ProtectionLedger;
  health: ProtectionHealth;
  /** How many of this class's checks are not working. Zero unless `degraded`. */
  degradedCount: number;
  /** How many have never been verified. Independent of `kind` — see `ProtectionHealthCounts`. */
  neverVerifiedCount: number;
  /** How many could not be read this refresh. Independent of `kind`. */
  sourceUnavailableCount: number;
  /**
   * The interceptor names behind this class.
   *
   * Present so a caller can join, count, or test — and deliberately NOT part of
   * anything this summary is asking to be rendered. mem#802 puts detector names
   * on the vendor's side of the split alongside thresholds and FP rates, so the
   * operator surface renders `checkCount` and never this. The operator-surface
   * test asserts no name from here reaches the DOM.
   */
  names: readonly string[];
}

export interface ProtectionSummary {
  windowDays: number;
  computedAt: string;
  /** Corpus-wide, deduped across classes — see the module note, property 3. */
  totals: ProtectionLedger & { checkCount: number };
  health: ProtectionHealthCounts & { totalChecks: number };
  /** Degraded first, then by interruptions descending. See `compareClasses`. */
  classes: ProtectionClassSummary[];
}

/** The catalog fields this derivation needs. Keeps the domain free of the artifact's full shape. */
export interface ProtectionCatalogEntry {
  guardName: string;
  failureClasses: string[];
}

const EMPTY_LEDGER: ProtectionLedger = {
  stopped: 0,
  flagged: 0,
  interruptions: 0,
  timeMs: null,
  measuredFires: 0,
  unmeasuredFires: 0,
};

/**
 * Sum a row set into one ledger.
 *
 * **Invariant: `measuredFires + unmeasuredFires` equals the sum of
 * `fireLog.window.fires` over the SAME row set — exactly, never more.**
 * (PR #3147 R1 asked for this stated and pinned.) It holds because the two
 * branches below partition each row's fires rather than counting them twice: a
 * row WITH a duration contributes `measuredFires` plus
 * `deriveInterceptorCost`'s residual `unmeasuredFires`, which is defined as
 * `fires - measuredFires`; a row WITHOUT one contributes its whole `fires` to
 * the unmeasured side and nothing to the measured side.
 *
 * The invariant matters because the rendered hint is "(over MEASURED of
 * MEASURED+UNMEASURED)". If the two sides could overlap, that denominator
 * would exceed the fires that actually exist and the surface would print
 * something like "over 2,900 of 2,600" — a figure that destroys trust in every
 * other number beside it. `protection-summary.test.ts` pins it for the mixed
 * case and for a guard carried by several classes.
 *
 * Note `fires` is ALL fires — `allow` and `other` included, not just the
 * interruptions. That is deliberate for a COST figure: a check that allowed the
 * call still spent the operator's wall-clock, so the time is measured over
 * everything that ran, not only over what interrupted.
 */
function accumulate(rows: readonly InterceptorAggregateRow[]): ProtectionLedger {
  let stopped = 0;
  let flagged = 0;
  let measuredFires = 0;
  let unmeasuredFires = 0;
  // Null until at least one row carries a duration, so "nothing was measured"
  // stays distinguishable from "the measured total was zero".
  let timeMs: number | null = null;

  for (const row of rows) {
    const decisions = row.fireLog.window.byDecision;
    stopped += decisions.deny;
    flagged += decisions.warn;

    const cost = deriveInterceptorCost(row);
    if (cost) {
      timeMs = (timeMs ?? 0) + cost.totalMs;
      measuredFires += cost.measuredFires;
      unmeasuredFires += cost.unmeasuredFires;
    } else {
      unmeasuredFires += row.fireLog.window.fires;
    }
  }

  return {
    stopped,
    flagged,
    interruptions: stopped + flagged,
    timeMs,
    measuredFires,
    unmeasuredFires,
  };
}

/**
 * Degraded first, then by interruptions descending, then by class id.
 *
 * "Needs-me over newest" (`/product-thinking` §5.1) makes degradation the
 * primary key. Cost is the secondary key because the surface's second job is
 * "is this worth its tax", and an inventory-shaped key — check count, or
 * alphabetical — would rank the 28-check `lost-signal` class above the 2-check
 * `secret-exposure` one on a page about what the enforcement is doing for you.
 *
 * The final tiebreak is the class id purely so the order is total and the
 * render is deterministic; it is not a meaningful ranking.
 */
function compareClasses(a: ProtectionClassSummary, b: ProtectionClassSummary): number {
  const aDegraded = a.health === "degraded" ? 0 : 1;
  const bDegraded = b.health === "degraded" ? 0 : 1;
  if (aDegraded !== bDegraded) return aDegraded - bDegraded;
  if (a.ledger.interruptions !== b.ledger.interruptions) {
    return b.ledger.interruptions - a.ledger.interruptions;
  }
  return a.classId.localeCompare(b.classId);
}

export function deriveProtectionSummary(
  snapshot: Pick<
    InterceptorAggregatesSnapshot,
    "rows" | "declaredOnlyRows" | "sourceFailures" | "windowDays" | "computedAt"
  >,
  entries: readonly ProtectionCatalogEntry[],
  classQuestions: Readonly<Record<string, string>>
): ProtectionSummary {
  const rowsByName = new Map<string, InterceptorAggregateRow>();
  for (const row of allAggregateRows(snapshot)) rowsByName.set(row.guardName, row);

  // The canary source failing makes EVERY health verdict indeterminate, not
  // zero — `deriveInterceptorState` already returns `canary-unavailable` per
  // row in that case, so this is belt-and-braces for a snapshot whose rows
  // somehow disagree with its own `sourceFailures`.
  const canaryFailed = snapshot.sourceFailures.includes("canary");

  const byClass = new Map<string, string[]>();
  for (const entry of entries) {
    for (const classId of entry.failureClasses) {
      const names = byClass.get(classId);
      if (names) names.push(entry.guardName);
      else byClass.set(classId, [entry.guardName]);
    }
  }

  const classes: ProtectionClassSummary[] = [];
  for (const [classId, names] of byClass) {
    const rows = names
      .map((n) => rowsByName.get(n))
      .filter((r): r is InterceptorAggregateRow => !!r);
    const statuses = canaryFailed
      ? rows.map((): CheckStatus => "source-unavailable")
      : rows.map(checkStatus);
    const { kind, degradedCount, neverVerifiedCount, sourceUnavailableCount } =
      foldHealth(statuses);
    classes.push({
      classId,
      // A class with no authored question still renders — with its key, which
      // is ugly and legible — rather than being dropped. A silently omitted
      // class is a coverage hole the reader cannot see.
      question: classQuestions[classId] ?? classId,
      checkCount: names.length,
      ledger: rows.length > 0 ? accumulate(rows) : EMPTY_LEDGER,
      health: kind,
      degradedCount,
      neverVerifiedCount,
      sourceUnavailableCount,
      names,
    });
  }

  classes.sort(compareClasses);

  // Deduped: an interceptor in three classes is one check, counted once.
  const distinctNames = new Set(entries.map((e) => e.guardName));
  const distinctRows = [...distinctNames]
    .map((n) => rowsByName.get(n))
    .filter((r): r is InterceptorAggregateRow => !!r);
  const totalStatuses = canaryFailed
    ? distinctRows.map((): CheckStatus => "source-unavailable")
    : distinctRows.map(checkStatus);
  const totalHealth = foldHealth(totalStatuses);

  return {
    windowDays: snapshot.windowDays,
    computedAt: snapshot.computedAt,
    totals: { ...accumulate(distinctRows), checkCount: distinctNames.size },
    health: { ...totalHealth, totalChecks: distinctNames.size },
    classes,
  };
}
