/**
 * Session-workspace git-state guard (mt#3021 SC2).
 *
 * Checks whether a session's workspace directory has an in-progress merge
 * (`MERGE_HEAD` present) or uncommitted changes — the two git-state
 * conditions under which deleting the workspace can destroy in-flight work.
 * Consumed by `deleteSessionImpl` and `cleanupSessionImpl`
 * (`session-lifecycle-operations.ts`) immediately before their destructive
 * filesystem operations.
 *
 * This check runs INSIDE the delete/cleanup implementations themselves, not
 * only at a command layer above them — the mt#3021 incident's actual
 * deletion path (a direct `deleteSessionImpl` call) bypassed the ONLY
 * existing safety check (`sessionHasUncommittedChanges`, which lives in
 * `session-cleanup.ts` and is consulted solely by the `session cleanup`
 * command layer, `src/adapters/shared/commands/session/cleanup-command.ts`).
 *
 * `MERGE_HEAD` presence is checked directly via the filesystem (not via
 * `git status`) because it catches a race `git status --porcelain` alone
 * cannot: per the mt#3021 spec's SC1 investigation, `git status --porcelain`
 * can read transiently CLEAN during a commit's stage→commit window even
 * though a merge is actively being finalized in that same window — exactly
 * the incident's race shape. Checking for the `MERGE_HEAD` file directly
 * closes that gap without depending on the working tree's momentary state.
 *
 * This is the git-state axis ONLY (per the spec's Scope: "SC2 here is the
 * git-state axis ONLY; the live-actor axis is orthogonal and lands
 * separately" — owned by mt#3100/mt#3103-3106). It intentionally does NOT
 * attempt any liveness/presence check.
 */
import { existsSync } from "node:fs";
import type { GitServiceInterface } from "../git/types";

export type GitStateGuardReasonCode = "merge-head-present" | "uncommitted-changes";

export interface GitStateGuardResult {
  blocked: boolean;
  reasonCode?: GitStateGuardReasonCode;
  message?: string;
}

export interface GitStateGuardFsOps {
  existsSync: typeof existsSync;
}

/**
 * Check a session workspace directory for the two destructive-delete
 * conditions. Returns `{ blocked: false }` when the directory doesn't exist
 * (nothing to protect) or when the git-state probe itself fails (fails OPEN
 * on probe error — mirrors `sessionCommit`'s own `hasUncommittedChanges`
 * probe-failure handling in `session-commands.ts`: an inability to determine
 * state is not itself evidence of a dirty/merging state, and per the spec's
 * "SC2 must not deadlock legitimate recovery" design decision this guard
 * must never turn an unrelated probe failure into a permanent block).
 */
export async function checkWorkspaceGitStateForDelete(
  gitService: Pick<GitServiceInterface, "hasUncommittedChanges">,
  workspaceDir: string,
  fsOps: GitStateGuardFsOps = { existsSync }
): Promise<GitStateGuardResult> {
  if (!fsOps.existsSync(workspaceDir)) {
    return { blocked: false };
  }

  // Session workspaces are plain clones (not worktrees/submodules), so
  // `.git` is always a real directory here — `MERGE_HEAD`'s path is stable.
  const mergeHeadPath = `${workspaceDir}/.git/MERGE_HEAD`;
  if (fsOps.existsSync(mergeHeadPath)) {
    return {
      blocked: true,
      reasonCode: "merge-head-present",
      message: `Session workspace at '${workspaceDir}' has an in-progress merge (MERGE_HEAD present)`,
    };
  }

  try {
    const dirty = await gitService.hasUncommittedChanges(workspaceDir);
    if (dirty) {
      return {
        blocked: true,
        reasonCode: "uncommitted-changes",
        message: `Session workspace at '${workspaceDir}' has uncommitted changes`,
      };
    }
  } catch {
    // Probe failure — fail open (see doc comment above).
  }

  return { blocked: false };
}
