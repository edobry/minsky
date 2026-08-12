/**
 * Interceptor-catalog regeneration (mt#4010).
 *
 * Keeps `src/generated/interceptor-catalog.json` — the artifact the cockpit's
 * `/interceptors` route renders — from drifting away from the authored data in
 * `.minsky/hooks/interceptor-descriptions.ts` and `.minsky/hooks/known-guard-names.ts`.
 *
 * Same auto-fix-and-restage shape as the completion-manifest step (mt#2622)
 * rather than the detect-and-block shape of the `compile --check` family, and
 * for the same reason: the artifact is mechanically derived from source with
 * zero editorial content, so re-staging a corrected copy carries none of the
 * "don't auto-commit an unreviewed content rewrite" risk.
 *
 * Extracted into its own module rather than added to `pre-commit.ts`, which is
 * already well over the max-lines ceiling — the split `bun-build-sync-regen.ts`
 * (mt#3091) and `claude-hooks-compile-regen.ts` (mt#2977) established.
 *
 * UNCONDITIONAL, not gated on which files are staged. The generator is a pure
 * function of the hook tree and completes in well under a second, and any
 * narrower heuristic ("only when `.minsky/hooks/**` changed") risks missing a
 * change made through a path it did not anticipate — reintroducing exactly the
 * staleness this step exists to prevent.
 *
 * @see scripts/build-interceptor-catalog.ts — the generator
 * @see src/hooks/pre-commit.ts `runCompletionManifestRegen` — the sibling this mirrors
 */
import type { HookResult } from "./pre-commit";

/** Repo-relative path of the generated artifact. */
export const INTERCEPTOR_CATALOG_PATH = "src/generated/interceptor-catalog.json";

/** Injected dependencies (the `this`-bound git runner + logger from PreCommitHook). */
export interface InterceptorCatalogRegenDeps {
  projectRoot: string;
  /** Run `git <args>` and return stdout (PreCommitHook.runGitArgv). */
  runGit: (args: string[]) => Promise<string>;
  /** Emit a CLI log line (log.cli). */
  logLine: (line: string) => void;
  /** Run a shell command (execAsync) — injected so the orchestration is unit-testable. */
  exec: (command: string, options: { cwd: string; timeout: number }) => Promise<unknown>;
}

/**
 * Build the failure result for an interceptor-catalog regeneration error.
 *
 * There is no stale-vs-broken distinction to make: the step always regenerates
 * (never `--check`s), so any thrown error means the generator itself failed and
 * re-running the commit will not help. Pure + exported for unit testing.
 */
export function classifyInterceptorCatalogRegenError(error: unknown): {
  logLines: string[];
  message: string;
} {
  const execError = error as { stdout?: string; stderr?: string };
  // `||`, not `??`: an EMPTY-string stderr must fall through to stdout — `??`
  // would treat `""` as "present" and never reach stdout (mirrors
  // `classifyCompletionManifestRegenError`).
  const detail = (execError.stderr ?? "").trim() || (execError.stdout ?? "").trim();
  const errorDetail = detail || (error instanceof Error ? error.message : String(error));
  const logLines = [
    "❌ Interceptor-catalog regeneration failed:",
    ...errorDetail.split("\n").map((line) => `   ${line}`),
    "💡 Fix the error above and retry the commit. This is a generator bug, not staleness — " +
      "re-running the commit will NOT help until the generator itself is fixed.",
  ];
  return {
    logLines,
    message: `Interceptor-catalog regeneration failed: ${errorDetail.split("\n")[0]}`,
  };
}

/**
 * True iff `git diff --name-only -- <path>`'s stdout indicates the regenerated
 * catalog differs from the index. `git diff` (no `--quiet`) always exits 0, so
 * this is a string check rather than an exit-code check. Pure + exported for
 * unit testing.
 */
export function catalogDiffIndicatesChange(diffStdout: string): boolean {
  return diffStdout.trim().length > 0;
}

/** Regenerate the interceptor catalog and re-stage it if it changed. */
export async function regenerateInterceptorCatalog(
  deps: InterceptorCatalogRegenDeps
): Promise<HookResult> {
  const { projectRoot, runGit, logLine, exec } = deps;

  try {
    // Reuses the same `build:interceptor-catalog` package script `bun run build`
    // invokes, so exactly one place names the generator's invocation path.
    await exec("bun run build:interceptor-catalog", {
      cwd: projectRoot,
      timeout: 15000,
    });
  } catch (error) {
    const result = classifyInterceptorCatalogRegenError(error);
    for (const line of result.logLines) logLine(line);
    return { success: false, message: result.message, exitCode: 1 };
  }

  let diffStdout: string;
  try {
    diffStdout = await runGit(["diff", "--name-only", "--", INTERCEPTOR_CATALOG_PATH]);
  } catch (error) {
    // A failure here is a git-plumbing problem, not a generator problem — fail
    // closed rather than silently skip staging a possibly-changed file.
    const errMsg = error instanceof Error ? error.message : String(error);
    logLine(`❌ Could not diff the regenerated interceptor catalog: ${errMsg}`);
    return {
      success: false,
      message: `Could not diff the regenerated interceptor catalog: ${errMsg}`,
      exitCode: 1,
    };
  }

  if (!catalogDiffIndicatesChange(diffStdout)) {
    return { success: true, message: "Interceptor catalog up-to-date", exitCode: 0 };
  }

  try {
    await runGit(["add", "--", INTERCEPTOR_CATALOG_PATH]);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logLine(`❌ Could not stage the regenerated interceptor catalog: ${errMsg}`);
    return {
      success: false,
      message: `Could not stage the regenerated interceptor catalog: ${errMsg}`,
      exitCode: 1,
    };
  }

  logLine("✅ Interceptor catalog regenerated and staged (was out of date).");
  return {
    success: true,
    message: "Interceptor catalog regenerated and staged",
    exitCode: 0,
  };
}
