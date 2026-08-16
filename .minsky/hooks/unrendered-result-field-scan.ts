// Unrendered-result-field scan — the imperative shell (mt#3913).
//
// Consumes ./unrendered-result-fields.ts and asks, at PR-creation time: does
// this change add a counter or flag to a `*Result` type that no operator-facing
// output site renders?
//
// Rationale, the discriminator, and why a log sink does not count as a render
// site all live in the pure core's header. This module is plumbing: read the
// branch diff, run the check, record a calibration entry, inject an advisory.
//
// ## Posture: log-only, fail-open
//
// Log-only because the question it asks — "is this field observability-purposed,
// and did the author intend it to be visible?" — is undecidable, and the check
// answers the mechanical proxy instead ("does anything print it?"). That proxy
// errs toward flagging internal-only fields, which is why it accumulates
// calibration data before any posture change rather than blocking a PR on a
// judgment it cannot make. Per ADR-024's ladder the rung decision comes from the
// measured data, not from this module's authoring.
//
// Fail-open because a missed unrendered field is cheaper than a blocked
// `session_pr_create`.

import { findUnrenderedResultFields } from "./unrendered-result-fields";
import type { UnrenderedField } from "./unrendered-result-fields";
import { CANARY_MODE_ENV, findRepoRoot, DEFAULT_FS, execWithPath } from "./types";
import type { ToolHookInput } from "./types";
import type { DispatchContext, GuardOutcome } from "./registry";

/** Cap on fields rendered into the warning; overflow is always stated. */
export const MAX_REPORTED_FIELDS = 6;

/** Override env var: set to "1"/"true"/"yes" to skip the scan entirely. */
export const OVERRIDE_ENV_VAR = "MINSKY_SKIP_UNRENDERED_RESULT_FIELD_SCAN";

function isOverridden(): boolean {
  const v = process.env[OVERRIDE_ENV_VAR];
  return v === "1" || v?.toLowerCase() === "true" || v?.toLowerCase() === "yes";
}

/**
 * Shaped per `guard-feedback-authoring.mdc`: guard-id header, the quoted
 * evidence that tripped it, an imperative directive, and the branch under which
 * NOT acting is correct.
 */
export function buildUnrenderedFieldWarning(fields: UnrenderedField[]): string {
  const lines = [
    "[unrendered-result-field-scan] This change adds result fields nothing prints.",
    "",
  ];
  for (const f of fields.slice(0, MAX_REPORTED_FIELDS)) {
    lines.push(`  - ${f.owner}.${f.name} (${f.file})`);
  }
  const overflow = fields.length - MAX_REPORTED_FIELDS;
  if (overflow > 0) {
    lines.push(`  ... and ${overflow} more (all recorded in the calibration log)`);
  }
  lines.push(
    "",
    "A field a human cannot see reports nothing when it matters. If these are meant to be",
    "operator-facing, render them at the command's output site — a log call does not count,",
    "because the originating incident WAS a warning written to a sink nobody was reading",
    "while the command printed success. If they are internal-only plumbing, leave them and",
    "say so in the PR body."
  );
  return lines.join("\n");
}

/**
 * The branch's diff against its merge-base with main.
 *
 * `main...HEAD` (three dots), not `main..HEAD`: the two-dot form re-reports
 * every change main has made since the branch diverged, which would make the
 * scan fire on fields this PR never added.
 */
function readBranchDiff(repoRoot: string): { text: string; failed?: string } {
  const res = execWithPath(["git", "diff", "main...HEAD"], { cwd: repoRoot, timeout: 10_000 });
  if (res.timedOut) return { text: "", failed: "git diff timed out" };
  if (res.exitCode !== 0) {
    // git's stderr on a failed `diff` is ASCII diagnostic text (ref names,
    // "unknown revision"), and this only ever reaches a calibration record.
    // eslint-disable-next-line custom/no-unsafe-string-truncation -- known-ASCII, see above
    const detail = res.stderr.trim().slice(0, 200);
    return { text: "", failed: `git diff exited ${res.exitCode}: ${detail}` };
  }
  return { text: res.stdout };
}

/**
 * Pure-function entry point invoked in-process by `./dispatch-pretooluse.ts`.
 * Returns `null` for silent allow, matching the dispatcher's contract.
 *
 * NEVER denies — see the posture note above.
 */
export async function run(
  input: ToolHookInput,
  _ctx: DispatchContext
): Promise<GuardOutcome | null> {
  if (isOverridden()) return null;

  const base = { ts: new Date().toISOString(), sessionId: input.session_id ?? null };

  // Canary isolation (mt#3824 R2): a canary must never depend on the state of a
  // real working tree, and whether the canary process has one is environment
  // state rather than something this module controls.
  if (process.env[CANARY_MODE_ENV] === "1") {
    return {
      calibration: {
        ...base,
        fields: [],
        outcome: "skipped",
        reason: "canary mode — branch diff not read",
      },
    };
  }

  const repoRoot = findRepoRoot(process.cwd(), DEFAULT_FS);
  if (!repoRoot) {
    return { calibration: { ...base, fields: [], outcome: "skipped", reason: "no repo root" } };
  }

  const diff = readBranchDiff(repoRoot);
  if (diff.failed) {
    // A scan that could not run is recorded so a sustained infra outage is
    // visible in the calibration data rather than reading as a clean pass.
    return { calibration: { ...base, fields: [], outcome: "skipped", reason: diff.failed } };
  }

  const fields = findUnrenderedResultFields(diff.text);
  const record = {
    ...base,
    fields: fields.map((f) => `${f.file}:${f.owner}.${f.name}`),
  };

  // Every evaluation is recorded, fired or not, so the MISS rate is measurable
  // rather than only the fire count — a fire-only log cannot support a rung
  // decision (`hook-observers.mdc`).
  if (fields.length === 0) {
    return { calibration: { ...record, outcome: "clean" } };
  }

  return {
    additionalContext: buildUnrenderedFieldWarning(fields),
    calibration: { ...record, outcome: "matched" },
  };
}
