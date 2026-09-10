/**
 * Enrollment in population review, keyed on CONSEQUENCE rather than substrate (mt#5046).
 *
 * ## Why this exists beside the registries that already do this
 *
 * A mechanism in this repo gets a calibration log, a watermark, a review cadence and a
 * coverage-receipt gate because of WHERE IT LIVES. `CALIBRATION_LOG_REGISTRY` and
 * `scripts/check-coverage-receipts.ts` enroll from `GUARD_REGISTRY` /
 * `STANDALONE_GUARD_CANARIES` plus one hand-maintained map
 * (`NON_GUARD_CALIBRATION_PRODUCERS`, sole entry `ask-form-lint`). The shipped
 * evaluation-loop instrumentation — `.minsky/hooks/fire-log.ts`,
 * `src/hooks/pre-commit-fire-log.ts`, `.minsky/hooks/merge-gate-fire-log.ts` — enrolls
 * guards, pre-commit steps and merge gates. Every one of those populations is named by
 * SUBSTRATE.
 *
 * None of them enrolls a mechanism because **a false positive silently removes a human from
 * a decision.** The ask policy-router is a domain function, so it enrolled in nothing: it
 * closed operator-bound asks with `responder: "policy"` and a citation, irreversibly, with no
 * review of the distribution it produced. Measured 2026-09-10: **1,723 policy-closed
 * `authorization.approve` asks, 45 distinct citations, none containing grant vocabulary** —
 * and the population query that exposes it takes thirty seconds. Nobody ran it for two months
 * (mem#1378).
 *
 * The sharpest illustration is one line wide: `ask-form-lint` runs in `createAsk` immediately
 * before `policyFirstRoute`, on the same ask. Form-lint rejects loudly and is calibrated. The
 * router disposes silently and is not.
 *
 * ## Relationship to the accepted evaluation loop — EXTEND, not compete
 *
 * "RFC: The evaluation loop — auditing the regulators" (Accepted 2026-07-08) already holds the
 * governing positions: *"Enforcement needs a budget"* and *"Every enforcement point should
 * write a fire-log."* Its Phase 1 SHIPPED (mt#2597). This module does not restate that loop —
 * it supplies the enrollment path the loop was specified without, because the RFC's own corpus
 * is named by substrate too ("the highest-traffic PreToolUse guards and all pre-commit steps",
 * later "merge gates").
 *
 * **Why a sibling stream rather than reusing the fire-log**, stated mechanically rather than as
 * a preference: `FireLogDecision` is `"allow" | "warn" | "deny"` — a guard evaluating an action
 * and permitting or refusing it. A disposer's outcome is a terminal ask state plus a responder
 * and a citation. Forcing the second into the first would either drop the citation — the field
 * the whole 45-citation finding is about — or widen a union that an ESLint rule
 * (`require-guard-outcome-in-fire-log`) and a shipped DB table already constrain. What IS
 * reused is the RFC's review SHAPE: a population read on a cadence, ending in a disposition.
 *
 * ## The predicate, and why it is deliberately narrow
 *
 * A code path is a **disposer** if it can set a terminal `AskState` — `closed`, `cancelled` or
 * `expired` — on an ask whose routing target is, or would be, `operator`, with a responder that
 * is not `operator`.
 *
 * It is grep-decidable on purpose. mem#1378's own conclusion: *"Do not build a generic 'all
 * heuristics must be calibrated' rule — unenrollable, which is exactly why the disposer registry
 * uses a grep-decidable predicate instead."* A census can enforce a decidable predicate; it
 * cannot enforce a judgement.
 *
 * @see mem#1378 — the structural analysis this implements (its measurements are `verified-1b`;
 *   its design was `inferred` until this module)
 * @see docs/architecture/adr-008-attention-allocation-subsystem.md — the ask subsystem
 * @see mt#4926 — owns removing the machine-filed commit-authorization emission
 * @see mt#3715 — owns whether `authorization.approve` stays policy-eligible; this registry is
 *   indifferent to how it lands (if the kind is removed, the router remains a registered
 *   disposer with an empty population, which is the correct end state)
 */

import type { AskState } from "./types";

/**
 * The terminal states a disposer can write.
 *
 * Derived from {@link AskState} rather than restated, so a new terminal state added to the ask
 * state machine is a type error here instead of a silently unenrolled disposal class.
 */
export type DisposedState = Extract<AskState, "closed" | "cancelled" | "expired">;

/** Every terminal state, for the census to scan on. */
export const DISPOSED_STATES: readonly DisposedState[] = ["closed", "cancelled", "expired"];

/**
 * SQL predicate identifying a machine-filed commit-authorization ask.
 *
 * Load-bearing for every population query below: the policy-closed population is TWO phenomena,
 * and a query that does not separate them overstates one by ~170x and hides the other. Measured
 * 2026-09-10: 1,714 machine-filed against 10 agent-authored.
 *
 * Keyed on `metadata.commitMessage` — the marker `sessionCommit`'s emit site stamps
 * (`session/session-commands.ts`) and the one `isCommitAuthAsk` (`stale-suspended-close.ts`)
 * already uses, whose docblock calls it *"a designed-for-purpose marker, not a title
 * heuristic."* The first draft of this module keyed on the `"Commit authorization:"` title
 * prefix, which is precisely the heuristic that predicate exists to avoid. Verified equivalent
 * before switching: over all 1,724 policy-closed rows the two agree on 1,714 with **zero
 * disagreements** — so the change is a move to the designed marker, not a change of population.
 */
export const MACHINE_FILED_SQL_PREDICATE = "metadata->>'commitMessage' is not null";

/**
 * Where a disposer's per-disposal record lands.
 *
 * `eventType: null` is a legal, DECLARED state — an enrolled disposer that emits nothing yet.
 * It requires `gap`, so an unemitted stream is a stated finding rather than an omission a
 * reader has to notice. This is the honest encoding of the measured situation: of the paths
 * below, only one emits at all.
 */
export interface DisposerEventStream {
  /** The `system_events.event_type` recording each disposal, or null when none is emitted. */
  readonly eventType: string | null;
  /** Required when `eventType` is null: what is missing, and what owns closing it. */
  readonly gap?: string;
}

/**
 * The query that renders this disposer's population for review.
 *
 * `separates` names the sub-populations the query MUST distinguish. It is not decoration: a
 * disposer whose population mixes machine-filed and agent-authored rows produces a rate that
 * describes neither, which is the reporting half of the defect this registry exists to catch.
 */
export interface DisposerPopulationQuery {
  readonly sql: string;
  readonly separates: readonly string[];
}

/**
 * How often the population is read.
 *
 * `per-calibration-review` rides the existing sweep cadence rather than introducing a timer —
 * the same choice ADR-032 makes for threshold tuning ("the tuner reads the corpus when the
 * corpus is already being read"), and for the same reason.
 */
export type DisposerReviewCadence = "per-calibration-review";

export interface DisposerRegistration {
  /** Stable id; the census and the review panel both address entries by it. */
  readonly id: string;
  /**
   * Repo-relative file containing the DISPOSAL SITE. The census keys on this.
   *
   * "Site" rather than "decider" is load-bearing. The policy path decides in `router.ts` and
   * constructs the terminal ask in `transports/policy-resolver.ts`; only the second is
   * mechanically findable, because `router.ts` writes no terminal state and calls no write
   * primitive. Keying the census on the decider would have made it blind to the one mechanism
   * this registry was built for — a probe that cannot fail (mem#704). {@link decidedIn} carries
   * the decider so the entry still reads back to where the judgement lives.
   */
  readonly file: string;
  /** The exported symbol at that site. */
  readonly symbol: string;
  /** Where the decision is made, when that is a different module from the site. */
  readonly decidedIn?: string;
  /** Which terminal states this path can write. */
  readonly disposes: readonly DisposedState[];
  readonly eventStream: DisposerEventStream;
  readonly populationQuery: DisposerPopulationQuery;
  readonly reviewCadence: DisposerReviewCadence;
}

/** Base of every population query — the ask-level filter each entry narrows. */
const POLICY_CLOSED_BASE = `select case when ${MACHINE_FILED_SQL_PREDICATE} then 'machine' else 'agent' end as population, count(*) from asks`;

/**
 * The enrolled disposers.
 *
 * Membership was traced against the tree on 2026-09-10 rather than inherited from mem#1378's
 * inventory, which was written a day earlier and carried its own "verify at implementation"
 * caveat. Two corrections came out of that trace and are recorded on the entries themselves.
 */
export const DISPOSER_REGISTRY: readonly DisposerRegistration[] = [
  {
    id: "policy-first-route",
    file: "packages/domain/src/ask/transports/policy-resolver.ts",
    symbol: "closeWithPolicy",
    decidedIn: "packages/domain/src/ask/router.ts (policyFirstRoute)",
    disposes: ["closed"],
    eventStream: {
      eventType: "ask.policy_closed",
      gap:
        "Emitted from ONE call site only (src/adapters/shared/commands/asks.ts:2461, the " +
        "asks.create command path), and that block sits behind a persistence-container check, " +
        "a DB-connection check and a swallowing catch. Measured 2026-09-10: 10 events against " +
        "1,723 closes, and all 10 sit on the 10 agent-authored asks. The 1,713 machine-filed " +
        "rows carry no ask.created event either, so they never reach that block at all. " +
        "Coverage of the block overall is 3.4% (317 of 9,244 asks since the event shipped " +
        "2026-06-04). Enumerating the creation paths is this task's SC5.",
    },
    populationQuery: {
      // Renders the CITATION DISTRIBUTION, not just a count: the defect is that the router
      // closes an operator-bound ask citing text that does not grant the action, so the count
      // alone cannot show it. Verified against production 2026-09-10 — this exact query
      // reproduces mem#1378's headline figure without a bespoke rewrite: 45 distinct quotes
      // across 1,724 closes, 6 of them in the 10-row agent-authored population.
      //
      // What it deliberately does NOT compute is whether a citation GRANTS. A word-level
      // vocabulary regex over the quotes returns 111 of 1,724 — every one a quote that
      // DISCUSSES authorization rather than conferring it, which is prose-about-the-thing
      // matching a matcher for the thing (the mt#5056 shape). That judgement belongs to the
      // review step, and keeping it out of the query is the evaluation-loop RFC's own posture:
      // early-phase metrics are deliberately judgment-free.
      sql: `with pc as (select case when ${MACHINE_FILED_SQL_PREDICATE} then 'machine' else 'agent' end as population, response->'payload'->'citation'->>'quote' as quote from asks where kind = 'authorization.approve' and routing_target = 'policy' and state = 'closed') select population, count(*) as closes, count(distinct quote) as distinct_citations from pc group by 1`,
      separates: ["machine-filed commit authorization", "agent-authored decisions"],
    },
    reviewCadence: "per-calibration-review",
  },
  {
    id: "advancement-expiry",
    file: "packages/domain/src/ask/advancement.ts",
    symbol: "runAskAdvancementSweep",
    disposes: ["closed", "expired"],
    eventStream: {
      eventType: null,
      gap:
        "This module contains no event emission of any kind (verified by grep, 2026-09-10). It " +
        "runs the same policyFirstRoute as the command path and writes the outcome through " +
        "persistRouteOutcome, so its disposals are invisible to every event consumer.",
    },
    populationQuery: {
      sql: `${POLICY_CLOSED_BASE} where state in ('closed','expired') and responder is distinct from 'operator' group by 1`,
      separates: ["machine-filed commit authorization", "agent-authored decisions"],
    },
    reviewCadence: "per-calibration-review",
  },
  {
    id: "stale-suspended-close",
    file: "packages/domain/src/ask/stale-suspended-close.ts",
    symbol: "runStaleSuspendedAskCloseSweep",
    // `expired`, not `closed` — the single write is `repo.transition(ask.id, "expired")` at
    // :283. The module's own counters are named `closedParentTerminal` / `closedSuperseded`,
    // which is what made `closed` the plausible-looking registration; the counter names
    // describe the TRIGGER, the transition describes the STATE. Registering the state the
    // module is named after rather than the one it writes would have left the expired
    // population unreviewed.
    disposes: ["expired"],
    eventStream: {
      eventType: null,
      gap: "No emission traced as of 2026-09-10; enrolled so the gap is declared rather than absent.",
    },
    populationQuery: {
      // Its two responders are declared in the module as RESPONDER_PARENT_TERMINAL and
      // RESPONDER_SUPERSEDED — both `system:`-prefixed, so both satisfy the predicate's
      // "responder that is not operator" clause. Scoped to `expired` to match what it writes.
      sql: `${POLICY_CLOSED_BASE} where state = 'expired' and responder like 'system:%' group by 1`,
      separates: ["machine-filed commit authorization", "agent-authored decisions"],
    },
    reviewCadence: "per-calibration-review",
  },
  {
    id: "close-as-resolved",
    file: "packages/domain/src/ask/close-as-resolved.ts",
    symbol: "closeAskAsResolved",
    // BOTH, and the split is by the ask's pre-terminal state rather than by the caller's
    // intent: `suspended -> closed` carries an audit-trail response, while
    // `detected|classified|routed -> cancelled` is the only transition reachable from those
    // states. A registry entry naming only `closed` would leave the cancelled population
    // unreviewed, which is the same shape of gap this module exists to close.
    disposes: ["closed", "cancelled"],
    eventStream: {
      eventType: null,
      gap: "No emission traced as of 2026-09-10; enrolled so the gap is declared rather than absent.",
    },
    populationQuery: {
      sql: `${POLICY_CLOSED_BASE} where state in ('closed','cancelled') and responder is distinct from 'operator' group by 1`,
      separates: ["machine-filed commit authorization", "agent-authored decisions"],
    },
    reviewCadence: "per-calibration-review",
  },
];

/**
 * Files that write a terminal ask state and are deliberately NOT disposers, with the reason.
 *
 * The census needs this: a bare "every terminal-state write must be registered" would fail on
 * paths where the OPERATOR is the responder, which is the ask system working rather than a
 * disposal. Each entry is a claim a reader can check against the file.
 */
export const NON_DISPOSER_TERMINAL_WRITERS: Record<string, string> = {
  "packages/domain/src/ask/disposer-registry.ts":
    "This module. It NAMES the terminal states and write primitives it enrolls, so it matches " +
    "its own scan — prose about a matcher tripping that matcher, which is the same shape " +
    "mt#5056 fixed on the deferral detectors. Exempted through the documented mechanism rather " +
    "than special-cased in the walker, so the exemption stays visible to a reader.",
  "packages/domain/src/ask/repository.ts":
    "The persistence primitive every path writes THROUGH. Registering it would enroll the " +
    "storage layer rather than the decisions that reach it, and would make the census " +
    "vacuous — every disposer would match one file.",
  "packages/domain/src/ask/transports/elicitation.ts":
    "Terminal state comes from the OPERATOR's own choice (accept -> closed, decline -> " +
    "cancelled). The responder IS the operator, so the predicate does not hold.",
  "packages/domain/src/ask/transports/subagent.ts":
    "Closes on a subagent's answer to a subagent-routed ask. The ask was never operator-bound, " +
    "so no human is removed from a decision.",
  "packages/domain/src/ask/reconciler.ts":
    "`walkToSuspended` transitions along a bounded map — detected->classified->routed->" +
    "suspended. No terminal state appears in it, so this path cannot dispose of anything. " +
    "Censused because the scan matches any `.transition(` rather than only terminal-argument " +
    "ones: a variable target (as here) defeats a literal-argument check, so the scan is " +
    "deliberately imprecise in the direction that produces an exemption to write rather than a " +
    "disposer to miss.",
  "packages/domain/src/ask/service-window-reaper.ts":
    "Its only transition writes `routed` (:414) — an ESCALATION back into the queue, the " +
    "opposite of a disposal. **This corrects mem#1378's inventory**, which names 'the reaper's " +
    "droppedCount path' among the six disposers: that path does not exist. `:225` reads " +
    "`const droppedCount = 0; // v1: no drop logic`, and the field is reported as a constant " +
    "zero. Re-register if drop logic ever lands.",
  "packages/domain/src/ask/edit.ts":
    "The only match is inside a DOCBLOCK (:166) describing how the cancelled terminal is " +
    "reached elsewhere. The scan reads file text and does not strip comments, so prose about a " +
    "disposal matches like a disposal — the same shape as this module's own self-match above. " +
    "Comment-stripping was not added: it would be a parser's job, and the failure direction " +
    "here is a spurious exemption rather than a missed disposer.",
};

/**
 * The write primitives a disposal actually goes THROUGH.
 *
 * Measured against the tree, and the first draft of this list was WRONG in a way worth keeping
 * as a caution: a `grep -o 'closeAsk'` reported hits in both sweep modules, so `closeAsk(` went
 * in — but every one of those hits was the PREFIX of `closeAskAsResolved`, and the literal
 * `closeAsk(` occurs zero times in the tree. The census then saw neither module. Two of four
 * registered disposers were invisible to the very scan that registers them, and only the
 * both-directions test below caught it.
 *
 * What they actually call: `advancement.ts` → `persistRouteOutcome`; `close-as-resolved.ts` →
 * `respondAndClose` / `close` / `recordCancellation` / `transition`; `stale-suspended-close.ts`
 * → `transition`. A census keyed only on the `state: "closed"` literal would miss all of them,
 * because they hand a state to a repository helper rather than writing the literal.
 */
const DISPOSAL_WRITE_CALLS = [
  "persistRouteOutcome(",
  "respondAndClose(",
  "recordCancellation(",
  ".transition(",
  "repo.close(",
] as const;

/** A file the census reads. Content is passed in so the scan is pure and testable. */
export interface CensusFile {
  readonly file: string;
  readonly content: string;
}

/** True when this file's text shows it can produce or persist a terminal ask state. */
export function isDisposalSite(content: string): boolean {
  if (DISPOSAL_WRITE_CALLS.some((call) => content.includes(call))) return true;
  return DISPOSED_STATES.some(
    (state) => content.includes(`state: "${state}"`) || content.includes(`state:"${state}"`)
  );
}

/**
 * Census: every disposal site must be registered or explicitly exempted.
 *
 * Returns the unregistered sites, so a caller reports WHICH file is missing rather than that
 * some count differs — the difference between a failure a reader can act on and one they have
 * to reproduce. Pure over its input by construction: the real-tree caller reads the filesystem,
 * the acceptance tests pass a synthetic file set, and both exercise this same function.
 */
export function findUnregisteredDisposalSites(files: readonly CensusFile[]): string[] {
  const registered = new Set(DISPOSER_REGISTRY.map((d) => d.file));
  return files
    .filter((f) => isDisposalSite(f.content))
    .map((f) => f.file)
    .filter((file) => !registered.has(file) && !(file in NON_DISPOSER_TERMINAL_WRITERS))
    .sort();
}

/**
 * True when a registration declares all three fields the RFC's loop needs to review it.
 *
 * Kept as a predicate rather than inlined in the test so the review panel can filter on the
 * same rule the census enforces — one definition, two consumers.
 */
export function hasReviewTriple(entry: DisposerRegistration): boolean {
  const streamDeclared =
    entry.eventStream.eventType !== null ||
    (entry.eventStream.gap !== undefined && entry.eventStream.gap.trim().length > 0);
  return (
    streamDeclared &&
    entry.populationQuery.sql.trim().length > 0 &&
    entry.populationQuery.separates.length > 0 &&
    entry.reviewCadence === "per-calibration-review"
  );
}
