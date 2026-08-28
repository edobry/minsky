// Guard-feedback shape enforcement — mt#3479.
//
// Turns the registry's `attentionCost.denialMessageSizeChars` annotations from
// hand-maintained DOCUMENTATION into an enforced CEILING, and enforces the
// advisory-text authoring standard (`.minsky/rules/guard-feedback-authoring.mdc`)
// against each guard's REAL rendered output.
//
// Why this has to run the canaries rather than read the source: a guard's
// feedback is assembled at runtime from a template plus matched evidence, so the
// only honest measurement is what `run()` actually produces. Reading string
// literals out of the source undercounts template-literal text and cannot see
// the matched-phrase lines at all — the first draft of the mt#3479 survey did
// exactly that and undercounted `turn-end-untaken-action-scan` by ~40%.
//
// WHAT THIS CLAIMS, AND HOW FAR (updated mt#3705). The ceiling used to be
// checked against ONE canary sample per guard, which for a guard whose output
// scales with its input made it a RATCHET against drift rather than a bound.
// mt#3479 recorded that limitation deliberately and deferred sizing the worst
// cases; the deferral was taken without a magnitude estimate, and the estimate
// turned out to be 2.7x (`guard-health-escalation-detector` declared 600 and
// rendered 1649 at six failing guards, having TWO unbounded axes: an uncapped
// list and an interpolated `Error.message`).
//
// So the shape of the check changed. Each guard is now classified GROWTH-SHAPED
// or FIXED-SHAPE below, every growth-shaped guard must either CAP its own output
// or declare a `worstCaseCanary`, and the ceiling is enforced against the larger
// of the two renders. The classification is asserted by name, so a new guard
// cannot join the growth-shaped class unnoticed.
//
// Still true: a guard is only bounded as well as its declared worst case is
// honest. `worstCaseCanary` must be posed at the SATURATING input, not a
// comfortable one — the classification receipt cannot check that for you.
//
// @see .minsky/rules/guard-feedback-authoring.mdc — the standard this enforces
// @see .minsky/hooks/canary-runner.ts — `CanaryResult.outcome`, added for this
// @see .minsky/hooks/dispatcher.ts — `MERGED_CONTEXT_BUDGET_CHARS`, whose
//      derivation consumes the annotations this test keeps honest

/* eslint-disable custom/no-real-fs-in-tests -- this file runs REAL guard
   canaries, several of which write priming fixtures through their `canary.setup`
   hook. A mock fs would defeat the point: the whole value of measuring rendered
   output is that it comes from the guard's production path. The real-fs blast
   radius is contained the same way `canary-runner.test.ts` contains it — a fresh
   mkdtemp root that MINSKY_STATE_DIR and CLAUDE_PROJECT_DIR are pointed at
   before any guard module loads, removed in afterAll, so nothing touches the
   developer's real ~/.local/state/minsky/ or this repo's real .minsky/. */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GuardRegistration } from "./registry";
import type { CanaryResult } from "./canary-runner";

/**
 * Env isolation, mirroring `scripts/run-guard-canaries.ts` EXACTLY.
 *
 * Set before the dynamic imports below, not at first use: several guards read
 * these at module load. `MINSKY_CANARY_MODE` additionally gates the test-only
 * seams (mt#3004) — memory-search's fixture stub and the daemon-staleness
 * tracker-home redirect. Without it two canaries fail with confusing errors
 * that look like guard breakage but are missing setup; that misdiagnosis cost a
 * survey round while authoring this file.
 */
const CANARY_STATE_DIR = mkdtempSync(join(tmpdir(), "mt3479-feedback-shape-"));
process.env["MINSKY_STATE_DIR"] = CANARY_STATE_DIR;
process.env["CLAUDE_PROJECT_DIR"] = CANARY_STATE_DIR;
process.env["MINSKY_CANARY_MODE"] = "1";

const { GUARD_REGISTRY } = await import("./registry");
const { runGuardCanary } = await import("./canary-runner");

/**
 * Patterns that must not appear in ADVISORY text. Both name the operator's
 * override escape hatch, which belongs in a deny message (where an operator is
 * deciding whether to override) and in `CLAUDE.md §Hook Files` (where overrides
 * are catalogued) — not in an injection whose sole reader is an agent being
 * asked to do more work.
 */
const BANNED_IN_ADVISORY: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /Override:\s*set\s+MINSKY_/, why: "override advertisement" },
  { pattern: /MINSKY_[A-Z_]+\s*=\s*1/, why: "override env-var assignment" },
];

interface Measured {
  guardName: string;
  declared: number;
  advisory: string;
  denial: string;
}

let measured: Measured[] = [];
let canaryResults: Array<{ reg: GuardRegistration; result: CanaryResult }> = [];

/**
 * Which registrations the measurement pass covers (PR #2635 R1).
 *
 * Named and exercised directly by a unit test below rather than left inline in
 * `beforeAll`: the bug it encodes — gating on `canary` alone, so a
 * worst-case-only guard is measured by nothing — cannot be caught by any
 * assertion over the CURRENT registry, because no guard is worst-case-only
 * today. A test that only compares real-registry sets would pass with the bug
 * reintroduced.
 */
function declaresAnyCanary(reg: Pick<GuardRegistration, "canary" | "worstCaseCanary">): boolean {
  return Boolean(reg.canary || reg.worstCaseCanary);
}

/**
 * Probes that threw or timed out, collected rather than thrown (PR #2889 R1) so
 * one broken probe cannot void every assertion in this file. Asserted empty by
 * its own test, which names the guard.
 */
const probeFailures: string[] = [];

/** Each `renderProbe`'s rendered text, by guard name. Module-scoped so the
 * receipt below can assert every declared probe actually produced text. */
const probed = new Map<string, string>();

/** How long a single `renderProbe` may take before it is treated as hung. */
const PROBE_TIMEOUT_MS = 5000;

/**
 * Bound a probe in time. A `renderProbe` is a pure render behind a dynamic
 * import, so it should finish in microseconds — but "should" is the assumption
 * an unbounded `await` in a shared `beforeAll` turns into a hung suite with no
 * attribution, which is the failure mode worth spending five lines to avoid.
 */
async function withProbeTimeout(probe: Promise<string>): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      probe,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`renderProbe exceeded ${PROBE_TIMEOUT_MS}ms`)),
          PROBE_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Text off an outcome, or "" when the guard produced none. */
function textsOf(result: CanaryResult | undefined): { advisory: string; denial: string } {
  const outcome = result?.outcome ?? undefined;
  return {
    advisory: typeof outcome?.additionalContext === "string" ? outcome.additionalContext : "",
    denial: typeof outcome?.deny?.reason === "string" ? outcome.deny.reason : "",
  };
}

beforeAll(async () => {
  canaryResults = [];
  for (const reg of GUARD_REGISTRY) {
    if (!reg.canary) continue;
    canaryResults.push({ reg, result: await runGuardCanary(reg) });
  }

  // mt#3705: for a GROWTH-SHAPED guard the ordinary canary is one sample, so
  // measuring it bounds nothing. Where a `worstCaseCanary` is declared, render
  // it too and enforce the ceiling against the LARGER of the two — that is what
  // turns the annotation from a ratchet-against-drift into a real ceiling.
  //
  // Run in a SECOND pass rather than inside the loop above so a worst-case
  // `setup` (which overwrites the same fixture files the ordinary canary's
  // setup writes) cannot corrupt a sibling's ordinary measurement.
  const worstCase = new Map<string, CanaryResult>();
  for (const reg of GUARD_REGISTRY) {
    if (!reg.worstCaseCanary) continue;
    worstCase.set(reg.name, await runGuardCanary(reg, undefined, "worstCase"));
  }

  // Measure every guard declaring EITHER canary — not just the ones with an
  // ordinary `canary` (PR #2635 R1 BLOCKING).
  //
  // Deriving `measured` from `canaryResults` (which is gated on `reg.canary`)
  // meant a guard declaring ONLY a `worstCaseCanary` was skipped outright: it
  // would render no text here, so it would be absent from the ceiling check AND
  // from the classification receipt's `producing` list — and the receipt's
  // completeness assertion would then fail against an entry the author had
  // correctly classified, pushing them to DELETE the classification rather than
  // fix the measurement. Precisely the invisible-omission class this file exists
  // to close, reintroduced one level up. No guard is worst-case-only today; the
  // regression test below keeps it from silently mattering when one is.
  // mt#4002: a CALIBRATION-FIRST guard returns no `additionalContext` at all —
  // its module gates injection off — so every measurement above is "" for it and
  // the ceiling below was being enforced against an empty string. Measured
  // across the whole population before this fix: five guards, ceilings declared
  // 400-1650, all measuring 0; five of six registrations were understated, by up
  // to 3.6x. `renderProbe` renders what the guard WOULD emit, so the ceiling
  // binds on real text without flipping any guard's posture.
  //
  // A probe that THROWS or HANGS must not take the sweep with it (PR #2889 R1).
  // `beforeAll` is shared by every test in this file, so an unguarded `await`
  // here converts one guard's broken probe into a total loss of the ceiling
  // check, the coverage receipt and the classification receipt at once — and the
  // failure would surface as a hook-file stack trace naming none of them. Each
  // probe is therefore isolated and bounded, and a failure is RECORDED and
  // asserted below rather than thrown: fail-closed, and attributable to the
  // guard that caused it.
  for (const reg of GUARD_REGISTRY) {
    if (!reg.renderProbe) continue;
    try {
      probed.set(reg.name, await withProbeTimeout(reg.renderProbe()));
    } catch (err) {
      probeFailures.push(`${reg.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const ordinaryByName = new Map(canaryResults.map(({ reg, result }) => [reg.name, result]));
  const longer = (a: string, b: string): string => (b.length > a.length ? b : a);
  measured = GUARD_REGISTRY.filter((reg) => declaresAnyCanary(reg) || Boolean(reg.renderProbe)).map(
    (reg) => {
      const ordinary = textsOf(ordinaryByName.get(reg.name));
      const worst = textsOf(worstCase.get(reg.name));
      return {
        guardName: reg.name,
        declared: reg.attentionCost?.denialMessageSizeChars ?? -1,
        advisory: longer(longer(ordinary.advisory, worst.advisory), probed.get(reg.name) ?? ""),
        denial: longer(ordinary.denial, worst.denial),
      };
    }
  );
});

afterAll(() => {
  rmSync(CANARY_STATE_DIR, { recursive: true, force: true });
});

describe("guard feedback — coverage receipt (mt#3479)", () => {
  // A size/style check that silently measures NOTHING passes just as loudly as
  // one that measures everything. Per mem#534 ("a detector isn't working because
  // it shipped — it works when its receipt proves it covered its space"), assert
  // the space actually covered, not merely the absence of failures.

  test("every renderProbe this test depends on rendered", () => {
    // The counterpart to the canary check below, for the calibration-first half
    // of the corpus (PR #2889 R1). A probe that throws is collected rather than
    // thrown so it cannot void the rest of the file — but silence would then be
    // indistinguishable from success, which is the coverage-loss shape this
    // whole receipt exists to prevent. So it fails HERE, naming the guard.
    expect(probeFailures).toEqual([]);

    const declaredProbes = GUARD_REGISTRY.filter((r) => r.renderProbe).map((r) => r.name);
    const rendered = declaredProbes.filter((name) => (probed.get(name) ?? "").length > 0);
    expect(rendered.sort()).toEqual(declaredProbes.sort());
  });

  test("every canary this test depends on still fires", () => {
    const notFiring = canaryResults
      .filter(({ result }) => result.passed !== true)
      .map(({ reg, result }) => `${reg.name} (passed=${result.passed}, error=${result.error})`);
    expect(notFiring).toEqual([]);
  });

  test("the set of guards producing feedback text is the expected one", () => {
    // Pinned by NAME, not by count: a count-only assertion cannot tell "a guard
    // stopped emitting" apart from "a new guard started", which is precisely the
    // silent-coverage-loss this receipt exists to catch.
    const producing = measured
      .filter((m) => m.advisory.length > 0 || m.denial.length > 0)
      .map((m) => m.guardName)
      .sort();

    expect(producing).toEqual(
      [
        "ask-routing-deferral-detector",
        "block-bulk-process-kill",
        "block-secret-file-read",
        // mt#4002: the five calibration-first guards now produce measurable text
        // through `renderProbe`. Before that they were absent from this receipt
        // entirely — not failing it, just silently outside the space it covers,
        // which is the coverage-loss shape mem#534 names.
        "build-claim-injection-detector",
        "calibration-review-cadence-detector",
        "causal-premise-detector",
        "chained-verification-commands",
        "truncated-outcome-read",
        "check-guessed-session-path",
        "cli-mcp-substitution",
        "code-mechanism-assertion-detector",
        "constructed-identifier-batch-detector",
        "context-fill-gauge",
        "cross-turn-hedge-detector",
        "duplicate-check-candidate-read",
        "flakiness-control-detector",
        "guard-health-escalation-detector",
        "inject-ask-responses",
        "inject-current-time",
        "inject-dispatch-watchdog",
        "inject-git-state",
        "inject-memory-capture",
        "inject-prod-state",
        "knowledge-acquisition-detector",
        "mcp-daemon-staleness-detector",
        "negative-existence-claim-detector",
        "memory-search",
        // mt#4215 — also a `renderProbe` producer, per the note above.
        "nonexistent-search-path",
        "operator-deferral-ask-surface",
        "operator-deferral-detector",
        "pre-narration-detector",
        "require-duplicate-check-record",
        "retrospective-trigger-scanner",
        "secret-request-in-chat-detector",
        "silent-stretch-detector",
        "skill-staleness-detector",
        "spec-criterion-claim-detector",
        "substrate-bypass-detector",
        "turn-end-bare-ref-scan",
        "turn-end-retro-scan",
        "turn-end-unescalated-incident-scan",
        "turn-end-untaken-action-scan",
        "turn-end-unwalked-task-scan",
        "wall-of-text-detector",
        // mt#2264. Present here while `INJECTION_ENABLED` is false, because
        // this receipt measures what a guard CAN render (via `renderProbe`),
        // not what it currently emits. Listing it now means the text is
        // size-checked from the day it ships rather than from the day it is
        // graduated — which is the point at which nobody re-measures.
        "warn-unwired-task-relationship",
      ].sort()
    );
  });

  test("every guard producing feedback declares an attentionCost annotation", () => {
    const undeclared = measured
      .filter((m) => (m.advisory.length > 0 || m.denial.length > 0) && m.declared < 0)
      .map((m) => m.guardName);
    expect(undeclared).toEqual([]);
  });
});

/**
 * Every feedback-producing guard, classified by whether its rendered length can
 * scale with its input (mt#3705).
 *
 * GROWTH-SHAPED on either axis: (1) an iteration over a runtime-length
 * collection, or (2) an interpolated value with no length bound of its own (a
 * caught `Error.message`, a matched span of agent prose). Axis (2) bites
 * independently of (1) — `guard-health-escalation-detector` was over its ceiling
 * at a list length of ONE, purely from an interpolated error message.
 *
 * FIXED-SHAPE guards interpolate only short scalars (a branch name, a count, a
 * timestamp, a single path). Their canary IS their worst case, so the mt#3479
 * regime already bounds them.
 *
 * The judgment is "can this plausibly exceed the annotation?", not "is any
 * substitution theoretically unbounded" — under the pedantic reading every guard
 * is growth-shaped and the classification stops discriminating.
 */
/** Named because it is referenced from three separate assertions in this file. */
const CHECK_GUESSED_SESSION_PATH = "check-guessed-session-path";

/** The one `FeedbackShape` value that is cross-checked against the registry. */
const WORST_CASE_CANARY = "worst-case-canary";

/** Growth-shaped, measured by a saturated `renderProbe` sample (mt#4002). */
const RENDER_PROBE_SAMPLE = "render-probe-sample";

type FeedbackShape =
  /** Interpolates only short scalars — its ordinary canary IS its worst case. */
  | "fixed"
  /** Growth-shaped, bounded by a cap constant in its own source. */
  | "capped"
  /** Growth-shaped, bounded and PROVEN so by a declared `worstCaseCanary`. */
  | "worst-case-canary"
  /**
   * Growth-shaped and NOT yet bounded — measured by a saturated `renderProbe`
   * sample rather than by a cap in its own source (mt#4002).
   *
   * Deliberately a distinct value rather than folding these into `"capped"`.
   * Calling an uncapped guard capped is the exact laundering this receipt exists
   * to prevent: the annotation would read as a ceiling when it is a sample at
   * whatever count the probe happened to pose. Every guard carrying this value
   * owes a cap (`…and N more`), which is `guard-feedback-authoring.mdc`'s
   * preferred fix and belongs to that guard's owner.
   */
  | "render-probe-sample";

const FEEDBACK_SHAPE: Record<string, FeedbackShape> = {
  // mt#4234: was `"capped"`, citing `cappedEvidenceLines x2` — which caps the
  // LINE COUNT (3) and never binds, because `detectDeferralPhrases` breaks after
  // one match per class. The PHRASE was uncapped: `matchedPhrase` is the regex's
  // whole matched span and two patterns bound theirs only by the next sentence
  // terminator, so the render grew 1:1 with the agent's prose. That is precisely
  // the laundering this receipt's `RENDER_PROBE_SAMPLE` doc warns about — an
  // annotation reading as a ceiling when it is a sample. Now genuinely bounded on
  // both axes (`MAX_RENDERED_PHRASE_CHARS` per line, `cappedEvidenceLines` on the
  // count) AND posed saturated by a `worstCaseCanary`, so it earns the stronger
  // value rather than the one it used to assert.
  "ask-routing-deferral-detector": WORST_CASE_CANARY,
  // Fixed body plus at most six PIDs (`pids.slice(0, 6)` then `…`) — the cap is
  // in `buildDenialReason`, so the message cannot grow with the kill's size.
  "block-bulk-process-kill": "capped",
  "block-secret-file-read": "fixed",
  // The five calibration-first guards, newly visible to this receipt (mt#4002).
  // Until `renderProbe` existed they rendered nothing measurable, so none of
  // them was ever classified — and five of six registrations turned out to be
  // understated, by up to 3.6x.
  "build-claim-injection-detector": "capped", // deploySurfaceFiles.slice(0, 6)
  "causal-premise-detector": RENDER_PROBE_SAMPLE, // one line per phrase, uncapped
  "constructed-identifier-batch-detector": RENDER_PROBE_SAMPLE, // one line per match, uncapped
  // mt#4701. Both EXCERPTS are capped (240 chars each, `MAX_EXCERPT_CHARS`), but
  // the FINDING COUNT is not — one line per decayed subject — so this is a sample
  // of a realistic worst case, not a proved ceiling. A cap on the finding count is
  // owed before any INJECTION_ENABLED flip, and the registration says so too.
  "cross-turn-hedge-detector": RENDER_PROBE_SAMPLE,
  "knowledge-acquisition-detector": RENDER_PROBE_SAMPLE, // researchTools joined, uncapped
  "operator-deferral-detector": "capped", // <=3 matches x 240-char contexts
  "operator-deferral-ask-surface": "capped", // same module, same renderer
  "calibration-review-cadence-detector": "capped", // ADVISORY_BUDGET_CHARS byte-budget fit (mt#3824)
  // Capped on BOTH axes — MAX_RENDERED_CLAIMS with an `...and N more` line, and
  // each phrase bounded by the matcher's own 120-char cap — and the ceiling is
  // posed by a `worstCaseCanary` that saturates both at once, including the
  // longer (denial) directive branch (mt#3658).
  "flakiness-control-detector": WORST_CASE_CANARY,
  // mt#4167: MAX_RENDERED_IDS with an `... and N more` line, and each id bounded
  // by its own form (a two-letter prefix, a separator, digits). Both axes are
  // saturated by the PRIMARY canary — which supplies `transcriptLines` so it
  // reaches the injecting path — so no second canary and no `renderProbe`: this
  // guard injects on real turns and belongs in the budget bucket.
  "duplicate-check-candidate-read": "capped",
  "chained-verification-commands": "capped", // MAX_LISTED_COMMANDS (mt#3910)
  // mt#4215: capped on BOTH rendered axes — MAX_RENDERED_PATHS with an `…and N
  // more` line, and MAX_SUGGESTIONS per entry — but the path STRINGS themselves
  // are unbounded, so the probe is a saturated sample rather than a proved
  // ceiling. Same classification, and same reason, as its sibling above.
  "nonexistent-search-path": RENDER_PROBE_SAMPLE,
  // mt#4096: two interpolations, both bounded — the command is the pipeline stage
  // (itself bounded by the shell) and the filter is one of two literal tokens.
  "truncated-outcome-read": "capped",
  // mt#4144: two interpolations, both a registry command id (a short dotted
  // string) — the second is a pure transform of the first, so neither grows with
  // the command being scanned.
  "cli-mcp-substitution": "capped",
  [CHECK_GUESSED_SESSION_PATH]: "fixed",
  "code-mechanism-assertion-detector": "capped", // slice(0, 6) claims
  // mt#4291. Every interpolation is a NUMBER except the model id on the
  // unknown-model path, which appends `assumed (model <id> not in the window
  // table)`. No list, no excerpt, no finding enumeration — so the canary's
  // render is the ceiling for any realistic model id (measured 269 known / 355
  // fallback against the declared 400), not a sample of an unbounded axis.
  "context-fill-gauge": "capped",
  "guard-health-escalation-detector": WORST_CASE_CANARY, // two capped sections + a truncated interpolation
  "inject-ask-responses": "capped", // MAX_ENUMERATED_ASKS x (MAX_TITLE_CHARS + MAX_CHOSEN_RENDER_CHARS) (mt#3564)
  "inject-current-time": "fixed",
  "inject-dispatch-watchdog": "capped", // MAX_ENUMERATED_FLAGS (mt#3485)
  "inject-git-state": "fixed",
  "inject-memory-capture": "capped", // MAX_DESCRIBED_CAPTURES x MAX_DESCRIBED_TOOL_CALLS (mt#3997)
  "inject-prod-state": "fixed",
  "mcp-daemon-staleness-detector": "capped", // MAX_PATHS_LISTED
  "memory-search": "capped", // bounded by its own token budget
  // mt#3918: the CLAIM axis is bounded (NEGATIVE_EXISTENCE_PATTERNS.length) and
  // posed at its bound, but the DONE-task-id axis is not — one id per cited DONE
  // task, no `…and N more`. Sample, not ceiling, until that cap lands.
  "negative-existence-claim-detector": RENDER_PROBE_SAMPLE,
  // mt#4286: was "fixed", with the comment "one excerpt, slice(0, 200)". That
  // described the calibration record's `context`, which `buildReminder` never
  // renders. The render emits one LINE PER MATCHED CATEGORY, so it scales with
  // the count — bounded by OUTCOME_CATEGORIES.length, which is "capped". Both
  // axes are genuinely bounded, so `renderWorstCase` is a proved ceiling.
  "pre-narration-detector": "capped", // one line per category, phrase at 200
  "require-duplicate-check-record": "fixed",
  "retrospective-trigger-scanner": "capped", // cappedEvidenceLines x3 (mt#3705)
  // One line per matched pattern PER SURFACE, and neither the match count nor
  // the surface count is capped — a turn with many matching sentences exceeds
  // the posed render. A saturated sample, not a proved ceiling; an `…and N more`
  // cap is owed before injection is enabled (mt#2428).
  "secret-request-in-chat-detector": RENDER_PROBE_SAMPLE,
  "silent-stretch-detector": "fixed",
  "skill-staleness-detector": "capped", // MAX_FILES_LISTED
  // One block per flagged criterion and a spec may carry many, so the
  // finding-count axis is UNBOUNDED — the criterion EXCERPT is capped (160 chars
  // in the matcher) but the number of them is not. A saturated sample, not a
  // proved ceiling; an `…and N more` cap is owed before injection is enabled.
  "spec-criterion-claim-detector": RENDER_PROBE_SAMPLE,
  "substrate-bypass-detector": "fixed", // excerpts, slice(0, 200)
  // mt#3286: one line per finding, and a closing status report can name many
  // entities — so the ordinary canary measures the floor. The declared
  // worstCaseCanary poses a report enumerating 12 tasks and 6 PRs; the render
  // itself does a byte-budget fit against ADVISORY_BUDGET_CHARS.
  "turn-end-bare-ref-scan": WORST_CASE_CANARY, // per-finding lines + budget fit
  "turn-end-retro-scan": "capped", // cappedEvidenceLines (mt#3705)
  "turn-end-unescalated-incident-scan": "capped", // slice(0, 2)
  // Reclassified by mt#3767. The evidence lines are still capped, but the
  // DIRECTIVE now varies by input — a fire matching the deferral corpus selects a
  // longer branch — so the ordinary canary (commitment-only) measures the shorter
  // one and bounds nothing. The declared worstCaseCanary is posed at the overlap.
  "turn-end-untaken-action-scan": WORST_CASE_CANARY, // capped lines + a branching directive
  // mt#3784: was `"capped"` on `MAX_LISTED_IDS` alone, which was true and no
  // longer sufficient — the restructure added a SECOND axis (two directive
  // branches of different lengths), and the id cap says nothing about which one
  // renders. Both axes are now saturated at once by a declared
  // `worstCaseCanary` (four ids so the `…and N more` line renders, and NO
  // primary-thread call so the longer branch is selected), so it earns the
  // stronger value. The measurement that motivated this: the registration's own
  // comment had drifted to "470 chars" against an actual 519, because nothing
  // had ever rendered the guard at its cap.
  "turn-end-unwalked-task-scan": WORST_CASE_CANARY,
  "wall-of-text-detector": "fixed", // one excerpt, EXCERPT_MAX_CHARS
  // mt#2264. `fixed`, and it is a PROVED ceiling rather than an assumption:
  // all three rendered dimensions are bounded — the list at
  // MAX_RENDERED_ASSERTIONS, the overflow suffix at one line, and the remedy
  // block at one line per axis, of which there are exactly three.
  // `renderWorstCase` saturates all three at once, and the module's own test
  // asserts its length against the registration's declared `attentionCost`,
  // so the two cannot drift the way `turn-end-unwalked-task-scan`'s comment
  // did (470 claimed against 519 actual).
  "warn-unwired-task-relationship": "fixed",
};

describe("guard feedback — growth-shape classification receipt (mt#3705)", () => {
  // The completeness half. Without this the classification is a comment: a new
  // feedback-producing guard would simply be absent, and absence reads the same
  // as "already bounded" to every check below.
  test("every feedback-producing guard is classified", () => {
    const producing = measured
      .filter((m) => m.advisory.length > 0 || m.denial.length > 0)
      .map((m) => m.guardName)
      .sort();
    expect(Object.keys(FEEDBACK_SHAPE).sort()).toEqual(producing);
  });

  // The teeth, in the one direction that IS statically decidable: the
  // "worst-case-canary" claim is checkable against the registry, both ways.
  //
  // What this deliberately does NOT claim: that a guard marked "capped" really
  // caps. No static check can see that — a cap is an arbitrary `slice` inside a
  // render function. The ceiling check below is the real enforcement for those;
  // this classification is what makes an UNBOUNDED guard visible as an omission
  // rather than as a blank.
  // Regression for PR #2635 R1: the measurement pass used to be gated on
  // `reg.canary`, so a guard declaring ONLY a `worstCaseCanary` was measured by
  // nothing. Asserting the invariant directly rather than via a fixture guard —
  // there is no worst-case-only guard today, and adding a fake registration to
  // prove it would itself have to be excluded from the receipts above.
  test("a worst-case-only guard is selected for measurement", () => {
    const ordinaryOnly = { canary: {} } as Pick<GuardRegistration, "canary" | "worstCaseCanary">;
    const worstCaseOnly = { worstCaseCanary: {} } as Pick<
      GuardRegistration,
      "canary" | "worstCaseCanary"
    >;
    const neither = {} as Pick<GuardRegistration, "canary" | "worstCaseCanary">;

    // The middle one is the regression: it was `false` before this fix.
    expect([ordinaryOnly, worstCaseOnly, neither].map(declaresAnyCanary)).toEqual([
      true,
      true,
      false,
    ]);
  });

  test("every guard declaring either canary is measured", () => {
    const declaring = GUARD_REGISTRY.filter(declaresAnyCanary)
      .map((r) => r.name)
      .sort();
    expect(measured.map((m) => m.guardName).sort()).toEqual(declaring);
  });

  test("the worst-case-canary classification matches the registry, both ways", () => {
    const claimed = Object.entries(FEEDBACK_SHAPE)
      .filter(([, shape]) => shape === WORST_CASE_CANARY)
      .map(([name]) => name)
      .sort();
    const declared = GUARD_REGISTRY.filter((r) => r.worstCaseCanary)
      .map((r) => r.name)
      .sort();
    expect(claimed).toEqual(declared);
  });
});

describe("guard feedback — declared size ceiling (mt#3479)", () => {
  test("no guard's rendered feedback exceeds its declared denialMessageSizeChars", () => {
    // Collect ALL violations before asserting: a per-guard `expect` inside a loop
    // reports only the first, which turns a corpus-wide correction into one
    // discovery per test run.
    const over = measured
      .filter((m) => m.declared >= 0)
      .flatMap((m) => {
        const rows: string[] = [];
        if (m.advisory.length > m.declared) {
          rows.push(`${m.guardName}: advisory ${m.advisory.length} chars > declared ${m.declared}`);
        }
        if (m.denial.length > m.declared) {
          rows.push(`${m.guardName}: denial ${m.denial.length} chars > declared ${m.declared}`);
        }
        return rows;
      });

    expect(over).toEqual([]);
  });

  test("an inflated fixture is caught (negative control for the ceiling)", () => {
    // Guards the assertion above against the vacuous-pass failure mode: if the
    // comparison were inverted or the operand empty, the real test would pass on
    // an empty `over` array forever. This proves the comparison has teeth.
    const inflated: Measured = {
      guardName: "synthetic",
      declared: 100,
      advisory: "x".repeat(101),
      denial: "",
    };
    expect(inflated.advisory.length > inflated.declared).toBe(true);
  });
});

describe("guard feedback — advisory authoring standard (mt#3479)", () => {
  test("no advisory text advertises its override env var", () => {
    const violations = measured.flatMap((m) =>
      BANNED_IN_ADVISORY.filter(({ pattern }) => pattern.test(m.advisory)).map(
        ({ why }) => `${m.guardName}: ${why}`
      )
    );
    expect(violations).toEqual([]);
  });

  test("deny messages are EXEMPT from the override ban", () => {
    // Not an oversight — a stated carve-out (mt#3479 `## Scope`). A blocking
    // gate's message is read by an operator deciding whether to override, so
    // naming the override there is the actionable remedy rather than noise.
    //
    // Asserted against a REAL guard rather than a synthetic string: if the
    // carve-out were hypothetical (no shipped deny message actually naming an
    // override), this test would pass vacuously forever and the exemption could
    // be deleted without anything noticing.
    const guessedPath = measured.find((m) => m.guardName === CHECK_GUESSED_SESSION_PATH);
    if (!guessedPath) throw new Error(`${CHECK_GUESSED_SESSION_PATH} is missing from the registry`);

    // Its deny message really does name MINSKY_SKIP_SESSION_PATH_CHECK=1 — the
    // exemption is load-bearing, not theoretical.
    const denyNamesOverride = BANNED_IN_ADVISORY.some(({ pattern }) =>
      pattern.test(guessedPath.denial)
    );
    expect(denyNamesOverride).toBe(true);

    // And it is nonetheless clean under the advisory standard, because the
    // advisory check reads `additionalContext` only.
    const advisoryViolations = BANNED_IN_ADVISORY.filter(({ pattern }) =>
      pattern.test(guessedPath.advisory)
    );
    expect(advisoryViolations).toEqual([]);
  });
});
