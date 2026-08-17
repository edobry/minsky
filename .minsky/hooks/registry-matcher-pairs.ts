/**
 * Declared guard co-registrations (extracted from `registry.ts` by mt#4055).
 *
 * Lives in its own module because `registry.ts` reached the 1500-code-line ceiling when mt#4055
 * added the fourth guard to the `Bash|mcp__minsky__session_exec` matcher. This block is the
 * cleanest seam in that file — a self-contained declarative list plus its one lookup, imported by
 * nothing but `registry.ts` (which re-exports both names, so every existing importer is
 * unaffected). Splitting the guard registrations themselves would be a far larger change and is
 * not this task's business.
 */

import type { GuardRegistration, LifecycleEvent } from "./registry";

/**
 * Guard pairs that INTENTIONALLY share an event + matcher (mt#3282).
 *
 * The overlap heuristic in `registry.test.ts` is deliberately false-positive-tolerant, and two
 * tool-scoped guards on the same matcher is a shape it cannot distinguish from an accidental
 * double-registration. The dispatcher supports it: on a matched event `getGuardsForEvent` returns
 * EVERY matching registration and `runGuards` executes them in registry order, short-circuiting on
 * the first `deny` (D1 first-deny-wins). Neither guard shadows the other — a guard only pre-empts a
 * later one by denying, which blocks the call either way.
 *
 * An entry here is a DECLARATION, not a silencer: each pair must be listed explicitly with a
 * rationale, so a genuinely accidental duplicate (the shape ADR-028 D7(2) exists to catch) still
 * fails the check.
 *
 * Keys are the two guard names, order-insensitive.
 */
export const INTENTIONAL_MATCHER_PAIRS: ReadonlyArray<readonly [string, string]> = [
  // Both inspect a Bash/session_exec command string for an unrelated defect:
  // one for a constructed session path, one for a secret-bearing file read.
  // Independent checks, independent overrides; running both is the point.
  ["check-guessed-session-path", "block-secret-file-read"],
  // Both inspect a `tasks_create` spec, at DIFFERENT tiers of the same concern
  // (mt#3722). The first asks whether a duplicate check was RECORDED and denies
  // when it was not — a literal-form presence test with no false-positive
  // surface, which is why it can deny. The second asks whether that record's
  // verdicts are TRUE, using heuristic token selection, and only ever warns.
  // Deliberately NOT folded into one guard: a single registration would put the
  // denying check and the calibration-first one behind one `denyCapable` flag,
  // one attentionCost budget and one canary, making the deny path's
  // zero-false-positive character depend on the scan's unmeasured one.
  ["require-duplicate-check-record", "duplicate-signature-scan"],
  // Third tier on the same `tasks_create` spec (mt#4004), and the reason all
  // three are separate registrations rather than one: they ask three different
  // questions about the same paragraph. Is the record PRESENT (deny), are its
  // verdicts TRUE (warn), and did the search it claims actually RUN (warn).
  // The third is the only one that reads SESSION state rather than the spec
  // alone, so its false-positive surface is unrelated to the second's token
  // heuristic and needs its own calibration log to be sized.
  ["require-duplicate-check-record", "duplicate-check-search-provenance"],
  ["duplicate-signature-scan", "duplicate-check-search-provenance"],
  // Same Bash/session_exec command string, third unrelated defect (mt#3910):
  // whether the call chains two or more VERIFICATION commands, which makes a
  // non-zero exit unattributable. Orthogonal to both siblings on this matcher —
  // a constructed session path and a secret-bearing read are properties of WHAT
  // the command touches; this is a property of HOW MANY result-bearing commands
  // share one invocation. Independent overrides; running all three is the point.
  ["check-guessed-session-path", "chained-verification-commands"],
  ["block-secret-file-read", "chained-verification-commands"],
  // Fourth question about the same `tasks_create` spec (mt#3658), and unrelated
  // to the other three: they all ask about the DUPLICATE CHECK — is the record
  // present, are its verdicts true, did its search run — while this asks whether
  // a claim about a test failure's MODE carries the control that would settle
  // it. Different paragraph, different evidence, different override. Folding it
  // into any of them would put a prose-vocabulary matcher, which has a real
  // false-positive surface, behind a `denyCapable` flag or a token-selection
  // canary sized for a different question.
  ["flakiness-control-detector", "require-duplicate-check-record"],
  ["flakiness-control-detector", "duplicate-signature-scan"],
  ["flakiness-control-detector", "duplicate-check-search-provenance"],
  // Fourth guard on the Bash/session_exec command string (mt#4055), and the
  // first that asks about the WORLD rather than the string: its three siblings
  // decide entirely from the text (a constructed path, a secret-bearing read,
  // a chained verification), while this one reads the text only to know WHICH
  // process to look for, and takes its decision from the process table. That is
  // why it cannot be folded into any of them — a probe-bearing guard behind a
  // sibling's canary would make that canary depend on the host's running
  // processes. Independent overrides; running all four is the point.
  ["check-guessed-session-path", "block-concurrent-bulk-mutation"],
  ["block-secret-file-read", "block-concurrent-bulk-mutation"],
  ["chained-verification-commands", "block-concurrent-bulk-mutation"],
  // Fifth guard on the Bash/session_exec command string (mt#4081), and back to
  // deciding purely from the text — but about a different property than any
  // sibling: not what the command TOUCHES (a constructed path, a secret) nor
  // how many results it CONFLATES (chained verification) nor whether a twin is
  // already running (concurrent bulk-mutation), but how much live state a
  // single call DESTROYS. Independent overrides; running all five is the point.
  ["check-guessed-session-path", "block-bulk-process-kill"],
  ["block-secret-file-read", "block-bulk-process-kill"],
  ["chained-verification-commands", "block-bulk-process-kill"],
  ["block-concurrent-bulk-mutation", "block-bulk-process-kill"],
  // Sixth guard on the Bash/session_exec command string (mt#4096). Every sibling
  // asks about the command's EFFECT — what it touches, how many results it
  // conflates, whether a twin is running, how much it destroys. This one asks
  // about the command's OUTPUT: whether the pipeline discards the outcome fields
  // a later claim will rest on. It is the only one whose subject is the pipe
  // TAIL rather than the leading command, and the only one that fires on a
  // command that is otherwise entirely correct to run. Independent overrides;
  // running all six is the point.
  ["check-guessed-session-path", "truncated-outcome-read"],
  ["block-secret-file-read", "truncated-outcome-read"],
  ["chained-verification-commands", "truncated-outcome-read"],
  ["block-concurrent-bulk-mutation", "truncated-outcome-read"],
  ["block-bulk-process-kill", "truncated-outcome-read"],
  // Sixth question about the same Bash/session_exec command string (mt#4144),
  // and the first that is not about the command alone: every sibling above asks
  // a property of WHAT the command does — a constructed path, a secret read, an
  // unattributable exit, a truncated outcome field, a concurrent bulk mutation,
  // a mass kill. This one asks what the command SUBSTITUTES FOR: it pairs the
  // command against a generated CLI->MCP equivalence oracle and against session
  // state (has any `mcp__minsky__*` call succeeded). Folding it into any sibling
  // would put that session-state leg, whose false-positive surface is entirely
  // unrelated to theirs, behind one calibration log and one override.
  ["check-guessed-session-path", "cli-mcp-substitution"],
  ["block-secret-file-read", "cli-mcp-substitution"],
  ["chained-verification-commands", "cli-mcp-substitution"],
  ["block-concurrent-bulk-mutation", "cli-mcp-substitution"],
  ["block-bulk-process-kill", "cli-mcp-substitution"],
  ["truncated-outcome-read", "cli-mcp-substitution"],
  // Two guards on `session_pr_create`, both reading the SAME branch diff and
  // both asking about operator-facing output — but about opposite failures, and
  // neither subsumes the other. `stale-signal-sweep` (mt#3959) fires on a label
  // the diff STOPPED emitting and looks OUTWARD, at durable artifacts still
  // quoting the old meaning. `unrendered-result-field-scan` (mt#3913) fires on a
  // field the diff ADDED and looks INWARD, at whether anything in the diff
  // prints it at all. One is rendered-under-a-wrong-name, the other is
  // rendered-nowhere; a diff can trip either, both, or neither. Independent
  // overrides; running both is the point.
  ["stale-signal-sweep", "unrendered-result-field-scan"],
  // mt#4044's `evidence-record-provenance` shares `session_pr_create` with both
  // guards above, and shares nothing else with either: it reads the COMMIT
  // MESSAGE / PR BODY for an evidence record that claims a run, and joins that
  // claim against the session transcript. The two above read the branch DIFF and
  // never look at a transcript. Same seam, disjoint inputs, disjoint failures —
  // so all three should run, and none subsumes another.
  //
  // Declared here on 2026-08-16 rather than at authoring time: this branch was
  // approved on 2026-08-12, when its `session_pr_create` co-registration did not
  // yet exist on main. mt#3913 landed the second guard afterwards, which is what
  // turned a single registration into a pair needing a declaration.
  ["stale-signal-sweep", "evidence-record-provenance"],
  ["unrendered-result-field-scan", "evidence-record-provenance"],
  // mt#4124's `new-surface-design-pass` is the fourth guard on this seam, and it
  // reads a THIRD thing: the branch's added-file STATUS plus the session's skill
  // invocations. The two diff guards above read the diff's CONTENT and never its
  // status; `evidence-record-provenance` reads the transcript but for a prose
  // record's discharge, not for which skills ran.
  //
  // Non-subsumption is easiest to see from the failure each admits. A PR can add
  // a new pane with no design pass while emitting every label it used to
  // (`stale-signal-sweep` quiet), rendering every field it added
  // (`unrendered-result-field-scan` quiet), and claiming no evidence record at
  // all (`evidence-record-provenance` quiet) — which is PR #2942, the incident
  // this guard exists for. Same seam, disjoint inputs, disjoint failures.
  ["stale-signal-sweep", "new-surface-design-pass"],
  ["unrendered-result-field-scan", "new-surface-design-pass"],
  ["evidence-record-provenance", "new-surface-design-pass"],
];

/** Is this pair declared as an intentional co-registration? */
export function isIntentionalPair(a: string, b: string): boolean {
  return INTENTIONAL_MATCHER_PAIRS.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

// ---------------------------------------------------------------------------
// D7(2) — duplicate-registration check (registry-completeness lint)
// ---------------------------------------------------------------------------

export interface DuplicateRegistration {
  a: string;
  b: string;
  event: LifecycleEvent;
  /** The matcher token(s) shared by both registrations. */
  sharedTokens: string[];
}

/**
 * Lifecycle events with NO tool-name concept — `matcher` is meaningless for
 * these (mirrors `getGuardsForEvent`'s "a matcher-less registration always
 * matches once its event matches" comment). Used by
 * {@link findDuplicateRegistrations} to scope the matcher-less-pair
 * exemption (R1 fix, mt#2652): the exemption is ONLY valid on these events.
 * `PreToolUse` and `PostToolUse` are tool-scoped — two matcher-less
 * registrations there genuinely both match every tool call, which IS a real
 * overlap risk and must still be flagged.
 */
export const NON_TOOL_SCOPED_EVENTS: ReadonlySet<LifecycleEvent> = new Set([
  "UserPromptSubmit",
  "SessionStart",
  "Stop",
  "SubagentStop",
  "SessionEnd",
]);

/**
 * Detect two registrations with the same event and an overlapping matcher —
 * ADR-028 D7(2)'s "duplicate-registration check". Two matchers "overlap"
 * when they share at least one literal `|`-delimited alternative token (a
 * conservative, false-positive-tolerant heuristic — exact regex
 * intersection is undecidable in general, and today's matcher strings are
 * always simple `|`-joined tool-name alternatives, never true regex
 * features).
 *
 * A registration with no matcher is treated as "matches everything." When
 * matched against a registration THAT HAS a matcher, this is a genuine
 * overlap risk (the matcher-less guard fires on every tool the matchered
 * guard's tokens name too) and is still flagged — on EVERY event, tool-scoped
 * or not. When BOTH registrations in a pair lack a matcher, the exemption is
 * narrower: it applies ONLY on {@link NON_TOOL_SCOPED_EVENTS} (Phase 2a,
 * mt#2652; scope-corrected R1) — there, a matcher-less registration is the
 * NORMAL, by-design shape (there is no tool name to match against), and
 * multiple independent guards legitimately share it — e.g. the six
 * UserPromptSubmit guidance detectors migrated in this phase. On a
 * TOOL-SCOPED event (`PreToolUse`/`PostToolUse`), two matcher-less
 * registrations genuinely BOTH match every tool call — that is exactly the
 * accidental-duplicate shape D7(2) exists to catch, so it is still flagged
 * there.
 */

export function findDuplicateRegistrations(
  registrations: GuardRegistration[]
): DuplicateRegistration[] {
  const dupes: DuplicateRegistration[] = [];
  const tokensOf = (matcher: string | undefined): Set<string> | null =>
    matcher === undefined
      ? null
      : new Set(
          matcher
            .split("|")
            .map((t) => t.trim())
            .filter(Boolean)
        );

  for (let i = 0; i < registrations.length; i++) {
    for (let j = i + 1; j < registrations.length; j++) {
      const a = registrations[i];
      const b = registrations[j];
      if (!a || !b) continue;
      if (a.event !== b.event) continue;
      if (a.name === b.name) continue;
      if (isIntentionalPair(a.name, b.name)) continue;

      const aTokens = tokensOf(a.matcher);
      const bTokens = tokensOf(b.matcher);
      if (aTokens === null && bTokens === null && NON_TOOL_SCOPED_EVENTS.has(a.event)) {
        // Both matcher-less on a non-tool-scoped event: the normal shape
        // for a family of independent guards — not a duplicate registration.
        continue;
      }
      if (aTokens === null || bTokens === null) {
        // Either exactly one side is matcher-less (genuine overlap risk on
        // any event), OR both sides are matcher-less on a TOOL-SCOPED event
        // (both genuinely match every tool call — still a real duplicate).
        dupes.push({
          a: a.name,
          b: b.name,
          event: a.event,
          sharedTokens: ["<matches everything>"],
        });
        continue;
      }
      const shared = [...aTokens].filter((t) => bTokens.has(t));
      if (shared.length > 0) {
        dupes.push({ a: a.name, b: b.name, event: a.event, sharedTokens: shared });
      }
    }
  }
  return dupes;
}
