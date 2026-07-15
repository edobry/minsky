/**
 * Ask form-lint calibration log writer (mt#2798).
 *
 * Advisory (warn-only) form-lint checks fire in `asks.create`'s execute
 * handler (see `./asks.ts`) via the pure domain checks in
 * `@minsky/domain/ask/form-lint`. This module is the thin filesystem-I/O
 * side of that mechanism — appends one JSONL line per Ask that fires at
 * least one form-lint match, so fire counts and diversity can be reviewed
 * via `/calibration-review` before any escalation to blocking (per the
 * task spec's Deliverable 2).
 *
 * Mirrors the append-JSONL pattern used by the UserPromptSubmit
 * calibration-first hooks (`.minsky/hooks/ask-routing-deferral-detector.ts`,
 * `.minsky/hooks/causal-premise-detector.ts`) — same shape (`matches:
 * {class, phrase}[]`), same fail-open-on-write-error posture, adapted for
 * an in-process command-adapter caller instead of a Claude Code hook (no
 * `ClaudeHookInput.cwd` here — the caller supplies the resolved workspace
 * path instead).
 *
 * PR #1941 review R1: the resolved workspace path (`ctx?.workspacePath ??
 * process.cwd()` at the `asks.create` callsite — the same fallback already
 * used by `./calibration.ts`'s `resolveWorkspacePath`, mt#2483) is verified
 * to actually be a Minsky/git workspace root (`.git` or `minsky.json`
 * present) before any write. An unverified path (e.g. an MCP server
 * process whose cwd is not tied to any repo) skips the write with a
 * warning rather than silently landing a JSONL file somewhere unexpected.
 *
 * Deliberately NOT registered in
 * `src/domain/calibration/calibration-sweep.ts`'s `CALIBRATION_LOG_REGISTRY`
 * in v1 — that registry has fixed test-asserted length/contents
 * (`calibration-sweep.test.ts`), and registering a 7th log is not named in
 * this task's Success Criteria or Acceptance Tests. The JSONL log itself
 * is still perfectly reviewable by hand (`cat .minsky/ask-form-lint-calibration.jsonl
 * | jq`) in the interim; registry wiring is a natural follow-up once this
 * log has accumulated enough fires to be worth a first review pass.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { log } from "@minsky/shared/logger";
import type { AskKind } from "@minsky/domain/ask/types";
import type { FormLintMatch } from "@minsky/domain/ask/form-lint";

/** Repo-relative path to the calibration JSONL log (per the task spec). */
export const ASK_FORM_LINT_CALIBRATION_LOG = ".minsky/ask-form-lint-calibration.jsonl";

/** Marker files that indicate `workspacePath` is a real Minsky/git workspace root. */
const WORKSPACE_ROOT_MARKERS = [".git", "minsky.json"];

/** One JSONL record: an Ask that fired >= 1 form-lint match at create time. */
export interface AskFormLintCalibrationRecord {
  timestamp: string;
  /** The created Ask's id, when available (best-effort; never blocks on absence). */
  askId?: string;
  kind: AskKind;
  matches: Array<{ class: FormLintMatch["check"]; phrase: string }>;
}

/**
 * True when `workspacePath` looks like a real Minsky/git workspace root
 * (carries a `.git` directory or a `minsky.json` file at its top level).
 *
 * Exported for direct testing. Never throws — any filesystem error (path
 * doesn't exist, permission denied) is treated as "not verified."
 */
export function isVerifiedWorkspaceRoot(workspacePath: string): boolean {
  try {
    return WORKSPACE_ROOT_MARKERS.some((marker) => existsSync(resolve(workspacePath, marker)));
  } catch {
    return false;
  }
}

/**
 * Append one calibration record as a JSONL line under `workspacePath`.
 *
 * Skips the write (logging a warning, never throwing) when `workspacePath`
 * doesn't verify as a real workspace root (`isVerifiedWorkspaceRoot`) — this
 * is the anchor-to-a-verified-root hardening from the PR #1941 review,
 * preventing a silent write to an arbitrary `process.cwd()` when no
 * session/workspace context is available.
 *
 * Fail-open beyond that: any filesystem error (permission denied, disk
 * full) is also swallowed after logging a warning — a calibration-log write
 * failure must never block or fail Ask creation (the calibration log is
 * purely advisory instrumentation, same posture as the hook-based
 * calibration writers this mirrors).
 */
export function appendAskFormLintCalibrationRecord(
  workspacePath: string,
  record: AskFormLintCalibrationRecord
): void {
  if (!isVerifiedWorkspaceRoot(workspacePath)) {
    log.warn(
      "asks.create: skipping form-lint calibration write — workspacePath does not verify " +
        "as a Minsky/git workspace root (no .git or minsky.json found)",
      { workspacePath }
    );
    return;
  }
  try {
    const logPath = resolve(workspacePath, ASK_FORM_LINT_CALIBRATION_LOG);
    const dir = dirname(logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf-8");
  } catch (err: unknown) {
    log.warn("asks.create: failed to write form-lint calibration log (best-effort, swallowed)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
