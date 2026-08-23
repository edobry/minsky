#!/usr/bin/env bun
// PreToolUse observer: a `Negative control:` or `Execution evidence:` record
// that CLAIMS a run, written into a commit message or a PR body, in a session
// where the corresponding run did not happen (mt#4044).
//
// The sibling `duplicate-check-search-provenance` (mt#4004) shipped this shape
// for ONE record type at ONE seam. mem#966's point 4 said at the time to
// "generalize past duplicate checks: any gate note of the form 'verified by
// <action>' is this same claim shape," and the next instance landed the
// following day on a different record type:
//
//   ORIGINATING INCIDENT (2026-08-12, mt#4024, commit 98e2ac5fd). A commit
//   message pushed to `task/mt-4024` carried a `Negative control —` block
//   describing a run that had not happened. It was run immediately after,
//   self-caught, and the real figure was 7 requests rather than the 2 claimed —
//   so the pushed claim was both unverified and wrong. Every gate passed: the
//   mt#3244 surface checks the label is PRESENT, exactly as mt#3673 does for
//   duplicate-check records, and nothing asked whether the run happened.
//
// WHY THE TWO RECORD TYPES GET DIFFERENT DISCHARGE RULES. This is the whole
// design, and it was settled by measurement against that transcript rather than
// by symmetry:
//
//   - `Execution evidence:` claims a test RUN. Discharged by any test-running
//     call. Weak, and deliberately so: it is mt#1459's own semantics, and its
//     failure mode is a session that ran nothing at all.
//   - `Negative control:` claims a run observed FAILING against the un-fixed
//     tree. "Did any test run?" cannot see it — the mt#4024 session ran `bun
//     test` five times before the commit. Nor can "did any test FAIL?" — one had
//     (a genuine bug, `PublishConversationDialog`). What discriminates is the
//     SUBJECT: no failing run naming the record's own subject preceded the
//     commit. Replayed against the real transcript, that fires on 98e2ac5fd and
//     goes silent on the counterfactual where the control ran first, because the
//     control's own failing run names `SharedConversationPage` in both its
//     command and its output. See `scripts/replay-evidence-provenance.ts`.
//
// The guard cannot see the future, and does not need to: at PreToolUse the
// transcript contains exactly the calls that already happened, so "before this
// write" is a property of the input rather than logic this module implements.
//
// Never denies. Calibration-first per ADR-024 and ask#6982 (Rung-1 extensions
// ship WITH an armed evidence stream — here, a calibration record on every path
// plus a `mentions-but-unmatched` outcome so the MISS rate is measurable, not
// only the fires). Override: MINSKY_SKIP_EVIDENCE_PROVENANCE=1.
//
// @see .minsky/hooks/evidence-provenance-table.ts — the shared discharge table
// @see .minsky/hooks/duplicate-check-search-provenance.ts — the tasks_create sibling
// @see mem#966 — the incident and the general rule

import { readFileSync } from "node:fs";
import { readInput } from "./types";
import type { ToolHookInput } from "./types";
import type { DispatchContext, GuardOutcome } from "./registry";
import { findToolCallsWithResults } from "./transcript";
import type { ToolCallWithResult } from "./transcript";
import { captureArtifact, CAPTURE_SCHEMA_VERSION } from "./judged-input-capture";
import { extractNegativeControlRecords, mentionsNegativeControl } from "./test-first-evidence";
import { extractExecutionEvidenceRecords } from "./require-execution-evidence-before-merge";
import {
  callContainsQuotedFailure,
  callNamesSubject,
  claimedCheckKinds,
  extractQuotedFailures,
  extractStrictQuotedFailures,
  extractSubjectTokens,
  failingTestRuns,
  fileWrites,
  lastRunIndexOfKind,
  orderingAgainstWrites,
  CHECK_KINDS,
} from "./evidence-provenance-table";
import type { CheckKind, FileWrite, OrderingVerdict } from "./evidence-provenance-table";

export const OVERRIDE_ENV_VAR = "MINSKY_SKIP_EVIDENCE_PROVENANCE";

// ---------------------------------------------------------------------------
// The artifact under judgement
// ---------------------------------------------------------------------------

/**
 * The text this tool call is about to write, across the three seams.
 *
 * `session_pr_create` accepts the body either inline or as `bodyPath`; **both are
 * read, unconditionally**, because a body written to a file is the SAME claim and
 * treating it as absent would make the file form a silent bypass.
 *
 * PR #2941 R1 caught this reading `bodyPath` only when no inline field was
 * present — and `session_pr_create` REQUIRES `title`, so on that seam `parts` is
 * never empty and the file was never read at all. The bypass was not a corner
 * case; it was the whole `--body-path` path, which is the shape `/prepare-pr`
 * reaches for whenever a body is long. The guarded gate is now gone: every
 * available source is appended.
 *
 * An unreadable `bodyPath` no longer discards the inline text either. Falling
 * back to what IS readable can only lose a record (a false negative, the safe
 * direction); returning null would downgrade a real claim to `skipped` on the
 * strength of a missing file.
 */
export function resolveArtifactText(toolInput: Record<string, unknown> | undefined): string | null {
  if (!toolInput) return null;
  const parts: string[] = [];
  for (const key of ["message", "body", "title"]) {
    const value = toolInput[key];
    if (typeof value === "string" && value.trim() !== "") parts.push(value);
  }
  const bodyPath = toolInput["bodyPath"];
  if (typeof bodyPath === "string" && bodyPath.trim() !== "") {
    try {
      parts.push(readFileSync(bodyPath, "utf8"));
    } catch {
      // Unreadable: fall through to whatever inline text exists. Only a call
      // with NO readable source at all is reported `skipped` by the caller.
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

// ---------------------------------------------------------------------------
// Claims and their discharge
// ---------------------------------------------------------------------------

export type ClaimKind = "negative-control" | "execution-evidence";

/**
 * Why an undischarged claim is undischarged (mt#4236).
 *
 * The two are different findings with different remedies, and collapsing them
 * is what the pre-mt#4236 single boolean did: `no-run-at-all` says the session
 * ran nothing, `no-run-of-kind` says it ran checks but not THIS one — a block
 * pasting a typecheck into a session that only ever ran tests. Criterion 3
 * requires both to stay separable from `stale-evidence`, which is a third thing
 * again: the run happened, of the right kind, and simply did not observe the
 * tree being shipped.
 */
export type DischargeDetail = "no-run-at-all" | "no-run-of-kind";

/** One evidence record found in the artifact, with the verdict reached on it. */
export interface ClaimVerdict {
  kind: ClaimKind;
  /**
   * For an execution-evidence claim, WHICH check it asserts (mt#4236). Absent on
   * a negative-control claim, whose kind is a test run by definition.
   */
  check?: CheckKind;
  /** Exact strings whose appearance in a call ties that call to this record. */
  tokens: string[];
  /**
   * `discharged` — the corresponding run is in the transcript.
   * `undischarged` — it is not; this is what the guard warns about.
   * `unadjudicable` — the record names no subject, so no join is possible. NOT
   * a pass: a record we cannot check is recorded as such so the population is
   * countable rather than quietly absorbed into the clean bucket.
   */
  verdict: "discharged" | "undischarged" | "unadjudicable";
  /** Set only when `verdict` is `undischarged`. */
  detail?: DischargeDetail;
  /**
   * Whether the discharging run OBSERVED the tree being shipped (mt#4236).
   *
   * A SECOND AXIS, deliberately not folded into `verdict`. `verdict` answers
   * "did the run happen", which is the recall axis mt#4067 owns and this task's
   * spec puts out of scope; this answers "did it happen in time". Anything not
   * discharged is `not-comparable` here — there is no run to order against.
   */
  ordering: OrderingVerdict;
}

/** Every evidence record in `text`, judged against the session's calls. */
export function judgeClaims(text: string, calls: readonly ToolCallWithResult[]): ClaimVerdict[] {
  const verdicts: ClaimVerdict[] = [];
  // The write side of the ordering join (mt#4236), computed once: a record is
  // stale when a file the discharging run READS was written after that run.
  const writes: FileWrite[] = fileWrites(calls);

  for (const record of extractNegativeControlRecords(text)) {
    const full = `${record.label}\n${record.body}`;
    const tokens = extractSubjectTokens(full);
    // The quoted-output join runs FIRST and needs no subject: a record that
    // pastes its failing run is discharged by that paste appearing in a real
    // result, whatever it names. Measurement forced this order — the subject
    // join alone false-positived on 4 of 4 sampled fires, every one of them a
    // record whose evidence was sitting in the body (see the table module).
    const quoted = extractQuotedFailures(full);
    const reds = failingTestRuns(calls);
    const discharged = reds.some(
      (c) => callContainsQuotedFailure(c, quoted) || callNamesSubject(c, tokens)
    );
    // EITHER join discharges; NEITHER available is the only unadjudicable case.
    // A quoted failure is itself a checkable claim — a paste that appears in no
    // real result is the fabrication this guard exists for — so a record that
    // quotes but names no subject must not fall through to "cannot adjudicate".
    // Adjudicability uses the STRICT `(fail)`-only set, not the widened one
    // (mt#4067). The widened shapes discharge when they match and say nothing
    // when they do not; treating them as grounds to condemn moved 22 records
    // from `unadjudicable` to `undischarged` and made the live fire count worse.
    const strict = extractStrictQuotedFailures(full);
    const verdict = discharged
      ? "discharged"
      : strict.length === 0 && tokens.length === 0
        ? "unadjudicable"
        : "undischarged";
    // ORDERING IS NOT APPLIED TO A NEGATIVE CONTROL, and this is a correction
    // to mt#4236's spec made by measuring rather than by reasoning it out.
    //
    // The spec expected the ordering axis to apply here too — the record's
    // granularity is already per-record, so only the staleness half was thought
    // to be missing. Built that way and swept over the 14 most recent
    // transcripts (2026-08-19), it reported `stale-evidence` on **30 of 33**
    // discharged control records: 91%.
    //
    // That number is not a finding, it is the PROCEDURE. A negative control is
    // (1) revert the fix, (2) run the test and observe it red, (3) RESTORE the
    // fix, (4) commit. Step 3 is a write to a file the run reads, and it is
    // always after step 2 — by construction, for every correctly-run control.
    // So the comparison returns `stale-evidence` whether or not the evidence is
    // stale, which is mem#704's can't-fail probe: same output in both states,
    // therefore no information. The 3 records that came back fresh are the tell
    // — those controls restored via `git stash pop`, a shell command
    // {@link fileWrites} deliberately does not recognize, so what the axis
    // actually measured was HOW THE AUTHOR RESTORED, not whether their evidence
    // was current.
    //
    // Firing at 91% of correctly-run controls is also the exact direction of
    // error the table module's header forbids, and mem#719's noise-erodes-trust
    // failure this guard's INJECTS_NOTHING_BY_DESIGN note already cites.
    //
    // The execution-evidence half, measured in the same sweep, discriminates:
    // test 0/39 stale, typecheck 6/17 (35%), lint 4/18 (22%). Distinguishing a
    // control's restore from an ordinary edit needs evidence this join does not
    // have; until it does, `not-comparable` is the honest verdict.
    verdicts.push({ kind: "negative-control", tokens, verdict, ordering: "not-comparable" });
  }

  // Per-CLAIM, not one boolean (mt#4236). One `Execution evidence:` block
  // routinely asserts several checks; each is adjudicated against a run of ITS
  // OWN kind, so a pasted typecheck can no longer be discharged by a test run.
  const evidenceRecords = extractExecutionEvidenceRecords(text);
  if (evidenceRecords.length > 0) {
    const lastRunByKind = new Map<CheckKind, number | null>(
      CHECK_KINDS.map((kind) => [kind, lastRunIndexOfKind(calls, kind)])
    );
    const ranSomeCheck = CHECK_KINDS.some((kind) => lastRunByKind.get(kind) !== null);

    for (const record of evidenceRecords) {
      const claimed = claimedCheckKinds(`${record.label}\n${record.body}`);
      // A block whose pastes this module does not recognize keeps mt#1459's own
      // semantics — it claims a test run, discharged by any test run — so its
      // verdict is byte-identical to the pre-mt#4236 one. Defaulting here rather
      // than recording `unadjudicable` is what keeps this change off the recall
      // axis mt#4067 owns, which this task's spec puts out of scope.
      const kinds: CheckKind[] = claimed.length > 0 ? claimed : ["test"];

      for (const check of kinds) {
        const runIndex = lastRunByKind.get(check) ?? null;
        if (runIndex === null) {
          verdicts.push({
            kind: "execution-evidence",
            check,
            tokens: [],
            verdict: "undischarged",
            detail: ranSomeCheck ? "no-run-of-kind" : "no-run-at-all",
            ordering: "not-comparable",
          });
          continue;
        }
        verdicts.push({
          kind: "execution-evidence",
          check,
          tokens: [],
          verdict: "discharged",
          ordering: orderingAgainstWrites(runIndex, writes, check),
        });
      }
    }
  }

  return verdicts;
}

/**
 * WHY THIS GUARD INJECTS NOTHING — measured, not conservative-by-default.
 *
 * The mt#4004 sibling warns on its matched path. This one deliberately does not,
 * because replaying the finished detector over 40 recent transcripts
 * (`scripts/replay-evidence-provenance.ts <t> --all`) measured the negative-
 * control half at 20 fires in 80 records, and sampling those fires found them
 * dominated by two classes neither join can reach:
 *
 *   1. A PROSE record naming what was REVERTED (`closeTab`,
 *      `port_or_known_default`, `pendingReplyBuffer.buffer`) rather than the test
 *      that went red. The record's vocabulary and the runner's barely intersect.
 *   2. A PR BODY edited in a LATER conversation than the run it reports. The
 *      evidence exists; it is simply not in this transcript.
 *
 * The execution-evidence half has its own (5 of 88, one session): a block whose
 * evidence is a migration generate or a DB query rather than a test run.
 *
 * Warning at that rate is the mem#719 failure mode — noise that teaches the
 * reader to discount the true positives, which is worse than silence for a check
 * whose whole value is being believed the one time it is right. So the stream is
 * armed and nothing is injected. Graduation is mt#4067, decided from the
 * calibration data.
 */
export const INJECTS_NOTHING_BY_DESIGN = true;

// ---------------------------------------------------------------------------
// Dispatcher entry point (ADR-028 D1/D2)
// ---------------------------------------------------------------------------

export function run(input: ToolHookInput, ctx: DispatchContext): GuardOutcome | null {
  const overrideVal = process.env[OVERRIDE_ENV_VAR];
  if (
    overrideVal === "1" ||
    overrideVal?.toLowerCase() === "true" ||
    overrideVal?.toLowerCase() === "yes"
  ) {
    return {
      auditLines: [
        `[evidence-record-provenance] OVERRIDE: ack=${overrideVal} session=${
          input.session_id ?? "unknown"
        } ts=${new Date().toISOString()}\n`,
      ],
    };
  }

  const base = {
    ts: new Date().toISOString(),
    sessionId: input.session_id ?? null,
    toolName: input.tool_name ?? null,
    captureSchema: CAPTURE_SCHEMA_VERSION,
  };

  const text = resolveArtifactText(input.tool_input);
  if (text === null) {
    return { calibration: { ...base, outcome: "skipped", reason: "no artifact text to read" } };
  }

  const lines = ctx.transcriptLines;
  if (!lines || lines.length === 0) {
    // A claim we cannot adjudicate is recorded as skipped, never as clean. A
    // guard whose "no transcript" path returned a pass would report an outage as
    // a run of correct behavior.
    return {
      calibration: { ...base, outcome: "skipped", reason: "no transcript lines available" },
    };
  }

  const verdicts = judgeClaims(text, findToolCallsWithResults(lines));
  const judged = {
    ...base,
    // Every field on ClaimVerdict is rendered here, deliberately. The calibration
    // record is this guard's ONLY output surface (INJECTS_NOTHING_BY_DESIGN), so
    // a field added to the verdict and not carried into the record would be
    // invisible to the reviewer it exists for — the mt#3913 unrendered-field
    // shape, in a module whose whole purpose is making a claim checkable.
    claims: verdicts.map((v) => ({
      kind: v.kind,
      check: v.check ?? null,
      verdict: v.verdict,
      detail: v.detail ?? null,
      ordering: v.ordering,
      tokens: v.tokens.length,
    })),
    judgedArtifact: captureArtifact(text),
  };

  if (verdicts.length === 0) {
    // The armed evidence stream (ask#6982): a text that MENTIONS a control but
    // carries no matchable record is the measurable miss, and it is the same
    // split mt#3511 had to add to the sibling surface before any widening there
    // could be argued from a rate rather than from anecdote.
    return {
      calibration: {
        ...judged,
        outcome: mentionsNegativeControl(text) ? "unmatched-shape" : "clean",
        reason: "no evidence record matched",
      },
    };
  }

  const undischarged = verdicts.filter((v) => v.verdict === "undischarged");
  // Stale evidence MATCHES (mt#4236). A record whose run predates the tree it
  // describes is the finding this task exists to surface, and labelling it
  // `clean` would leave it out of every review that filters on `matched` — a
  // detection recorded where nobody looks is mem#1020's inert probe. It rides
  // the same stream rather than a new one, and the `reason` below is what keeps
  // the two populations separable at review time.
  const stale = verdicts.filter((v) => v.ordering === "stale-evidence");
  if (undischarged.length === 0 && stale.length === 0) {
    return { calibration: { ...judged, outcome: "clean", reason: "every record discharged" } };
  }

  const classes: string[] = [];
  if (undischarged.length > 0) classes.push(`undischarged=${undischarged.length}`);
  if (stale.length > 0) classes.push(`stale-evidence=${stale.length}`);

  // `matched` and no `additionalContext` — see INJECTS_NOTHING_BY_DESIGN.
  return { calibration: { ...judged, outcome: "matched", reason: classes.join(" ") } };
}

// ---------------------------------------------------------------------------
// Standalone CLI entry point (fail-open: any error allows the call)
// ---------------------------------------------------------------------------

if (import.meta.main) {
  try {
    // Deliberately does NOT call `run()`, for the reason the sibling guard states:
    // the discriminating input is `ctx.transcriptLines`, which only the dispatcher
    // populates (D6), so a standalone invocation could only ever reach the
    // "cannot adjudicate" branch. Fabricating a DispatchContext to get there
    // would be a stub that looks like a code path.
    await readInput<ToolHookInput>();
    process.stderr.write(
      "[evidence-record-provenance] standalone invocation: this guard reads " +
        "dispatcher-parsed transcript lines and has nothing to check outside it. No-op.\n"
    );
    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `[evidence-record-provenance] fail-open: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
    process.exit(0);
  }
}
