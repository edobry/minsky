/**
 * Canary declarations for STANDALONE (non-GUARD_REGISTRY) guards — mt#2889
 * (evaluation-loop Phase 1 completion).
 *
 * Every standalone guard's `if (import.meta.main) { ... }` entrypoint is
 * plumbing: read stdin -> call the guard's own exported PURE decision
 * function -> write output. That exported pure function IS the guard's real
 * decision logic, so calling it directly (no subprocess spawn) exercises
 * the exact production code path — mirroring the precedent every
 * standalone guard's own `.test.ts` file already establishes (e.g.
 * `block-git-gh-cli.test.ts` imports `checkDenial` directly).
 *
 * `scripts/` already has precedent for importing directly from
 * `.minsky/hooks/` (see `scripts/grant-guard-override.ts`,
 * `scripts/grant-subagent-merge.ts`).
 *
 * @see mt#2889 — this task
 * @see .minsky/hooks/canary-runner.ts — StandaloneGuardCanary, runAllStandaloneCanaries
 * @see scripts/run-guard-canaries.ts — the CLI entrypoint consuming this array
 */

import type { StandaloneGuardCanary } from "../../.minsky/hooks/canary-runner";

export const STANDALONE_GUARD_CANARIES: StandaloneGuardCanary[] = [
  {
    guardName: "block-git-gh-cli",
    expects: "deny",
    check: async () => {
      const { checkDenial, parseCommands } = await import("../../.minsky/hooks/block-git-gh-cli");
      const parsed = parseCommands("git push origin main")[0];
      if (!parsed) return false;
      const reason = checkDenial(parsed, "bash");
      return reason !== null;
    },
  },
  {
    guardName: "require-session-for-main-workspace-edits",
    expects: "deny",
    check: async () => {
      const { checkFilePathDenial, MAIN_WORKSPACE } = await import(
        "../../.minsky/hooks/require-session-for-main-workspace-edits"
      );
      // A file under MAIN_WORKSPACE that does not exist on disk -> the
      // conflict-marker carve-out's readFile throws -> hasMarkers=false ->
      // denied. No real file access needed (readFileSync throws ENOENT for a
      // nonexistent path), so this is safe against the real repo checkout.
      const decision = checkFilePathDenial(
        "Edit",
        `${MAIN_WORKSPACE}/mt2889-canary-nonexistent-file.ts`
      );
      return decision.denied;
    },
  },
];
