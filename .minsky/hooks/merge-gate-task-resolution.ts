// Shared task-id resolution for `session_pr_merge` PreToolUse merge gates — mt#3355.
//
// `session_pr_merge` accepts TWO optional selectors, `task` and `sessionId`. Five merge
// gates read only `tool_input.task` and exited `allow` the moment it was empty, so a merge
// invoked by `sessionId` — a documented, first-class way to call the tool — bypassed all of
// them at once, emitting no warning. Measured over 316-318 recorded invocations per gate:
// 36 real merges (11.4-11.6%) were evaluated by no gate at all. An `allow` from a gate that
// evaluated the PR and an `allow` from a gate that never fetched it were byte-identical in
// the fire log except for `durationMs`.
//
// This module lifts the resolver that `block-subagent-merge-without-grant.ts` already had
// (its doc comment recorded the binding constraint quoted below) into one place, and adds
// the piece none of the gates had: a report of WHICH source produced the id, so a
// non-evaluation is distinguishable from a clean pass.
//
// **DB-free by construction.** The branch fallback parses `git rev-parse --abbrev-ref HEAD`
// rather than looking the session up by id, deliberately NOT the DB-backed lookup
// `record-subagent-invocation.ts` uses — that would violate the hooks' self-containment
// invariant (`.minsky/hooks/SPEC.md`). At merge time `cwd` is typically the session
// workspace, whose branch is `task/mt-NNNN`, so the fallback covers the common shape of the
// currently-silent case.
//
// **The `sessionId` channel (mt#3380).** A `session_pr_merge` invoked from the MAIN workspace
// with a `sessionId` selector — the `/merge-coordination` main-agent pattern — sits on branch
// `main`, so the `cwd` fallback cannot help it. mt#3355 shipped that case as warned-but-not-
// recovered, on the grounds that resolving it needed a session lookup. It does not: `sessionId`
// names a directory under the sessions root, and that directory's branch is the same
// `task/mt-NNNN` the existing fallback already parses. So the third channel is the SAME
// `git rev-parse`, pointed at a path derived from `sessionId` — still no DB, still no session
// record, still self-contained. Observed cost of the gap before this channel existed: the
// mt#3371 merge (2026-07-30) produced five identical warnings and zero gate evaluations.
//
// **What still does NOT resolve, and why the source is reported.** A `sessionId` naming a
// workspace that is no longer on disk — the post-merge cleanup removes it, and a stale or
// mistyped id never had one — resolves to `unresolved`. That is correct: with no workspace
// there is no branch to read, and inventing an id would be worse than warning. The reported
// `TaskIdResolutionSource` is what keeps a recovered merge distinguishable from a merely-warned
// one in the fire log (mt#3355 Success Criterion 6), which is the signal mt#3350 depends on.
//
// Dependency-free per `.minsky/hooks/SPEC.md`'s invariant: the sibling `./types` plus node
// builtins (the same latitude `check-guessed-session-path.ts` takes with `node:fs`).
//
// @see mt#3355 — the warn-instead-of-allow fix this module shipped with
// @see mt#3380 — the `sessionId` channel
// @see .minsky/hooks/block-subagent-merge-without-grant.ts — the resolver's original home
// @see .minsky/hooks/fire-log.ts — `FireLogEntry.taskResolutionSource`, where the source lands
// @see .minsky/hooks/merge-gate-fire-log.ts — `MergeGateFireLogContext`, how gates report it

import { join } from "node:path";
import { execSync } from "./types";
import type { ToolHookInput } from "./types";
import type { TaskResolutionSource } from "./fire-log";

/**
 * Which channel produced the task id for this merge-gate invocation.
 *
 * - `tool_input` — the caller passed `task` directly (the common form).
 * - `branch-fallback` — `task` was absent; the id came from the `task/mt-<id>` branch
 *   checked out in `cwd`.
 * - `session-workspace-branch` — `task` was absent and `cwd` was not a session workspace;
 *   the id came from the `task/mt-<id>` branch of the workspace named by `sessionId`.
 * - `unresolved` — no source yielded an id. The gate cannot evaluate the PR, and
 *   MUST say so rather than exiting `allow`.
 *
 * Aliased from `fire-log.ts`'s persisted-schema type rather than redeclared: these values
 * are written to the fire log verbatim, so a second declaration could drift from the one
 * readers of the log actually parse.
 */
export type TaskIdResolutionSource = TaskResolutionSource;

export interface TaskIdResolution {
  /** The resolved task id (e.g. `mt#3355`), or `null` when `source` is `unresolved`. */
  taskId: string | null;
  source: TaskIdResolutionSource;
}

/** Matches a session workspace's branch, the `task/mt-<id>` convention `session_start` creates. */
const TASK_BRANCH_PATTERN = /^task\/mt[-#](\d+)$/;

/**
 * Root directory session workspaces live under.
 *
 * Mirrors the resolution order the domain layer already uses
 * (`packages/domain/src/session/dispatch-intent-writer.ts`, `src/cockpit/prod-state-cache.ts`):
 * `MINSKY_STATE_DIR`, else `XDG_STATE_HOME`, else `$HOME/.local/state`. Re-derived here rather
 * than imported because this module may not import from the domain layer
 * (`.minsky/hooks/SPEC.md`); if the domain's order ever changes, this must change with it or
 * the `sessionId` channel silently stops resolving (and degrades to a warning, not a bad id).
 */
function sessionsRoot(): string {
  const stateDir =
    process.env["MINSKY_STATE_DIR"] ??
    (process.env["XDG_STATE_HOME"]
      ? join(process.env["XDG_STATE_HOME"], "minsky")
      : join(process.env["HOME"] ?? "", ".local", "state", "minsky"));
  return join(stateDir, "sessions");
}

/** Read `dir`'s checked-out branch and parse a task id out of it. Never throws. */
function taskIdFromBranchAt(dir: string): string | null {
  try {
    const result = execSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: dir,
      timeout: 3000,
    });
    if (result.exitCode !== 0) return null;
    const match = result.stdout.trim().match(TASK_BRANCH_PATTERN);
    return match ? `mt#${match[1]}` : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the task id for a `session_pr_merge` invocation, reporting its source.
 *
 * Channels are tried in precedence order: the explicit `task` selector, then the `cwd`
 * branch, then the workspace named by `sessionId`.
 *
 * Never throws: a nonexistent `cwd` or session workspace, a non-git directory, or any other
 * spawn-level failure resolves to `unresolved` rather than propagating. A gate's job on
 * `unresolved` is to WARN (see this module's header) — swallowing the failure into a bare
 * `allow` is the defect this function exists to remove, so callers must not reintroduce it.
 */
export function resolveMergeGateTaskId(input: ToolHookInput): TaskIdResolution {
  const fromToolInput = input.tool_input?.["task"];
  if (typeof fromToolInput === "string" && fromToolInput.trim().length > 0) {
    return { taskId: fromToolInput.trim(), source: "tool_input" };
  }

  const cwd = input.cwd;
  if (cwd) {
    const fromCwd = taskIdFromBranchAt(cwd);
    if (fromCwd) return { taskId: fromCwd, source: "branch-fallback" };
  }

  const sessionId = input.tool_input?.["sessionId"];
  if (typeof sessionId === "string" && sessionId.trim().length > 0) {
    const fromSession = taskIdFromBranchAt(join(sessionsRoot(), sessionId.trim()));
    if (fromSession) return { taskId: fromSession, source: "session-workspace-branch" };
  }

  return { taskId: null, source: "unresolved" };
}

/**
 * The operator-visible warning a gate emits when no task id is resolvable.
 *
 * Every gate emits the SAME text (parameterized by guard name) on purpose: the point of
 * mt#3355 is that a non-evaluation is legible as such wherever it appears, and five gates
 * each phrasing it differently would put that legibility back in the reader's head.
 */
export function unresolvedTaskWarning(guardName: string): string {
  return (
    `[${guardName}] Could not resolve a task id for this merge — \`tool_input.task\` is absent, ` +
    `\`cwd\` is not on a \`task/mt-<id>\` branch, and no \`sessionId\` named an on-disk session ` +
    `workspace. This gate did NOT evaluate the pull request; this is NOT a clean pass. ` +
    `Re-invoke \`session_pr_merge\` with \`task: "mt#<id>"\`, or run it from the session ` +
    `workspace, to get an actual check.`
  );
}
