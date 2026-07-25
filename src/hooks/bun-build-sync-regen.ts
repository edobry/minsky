/**
 * bun-build invocation sync: Dockerfile auto-regen + package.json check
 * (mt#3091).
 *
 * Extracted from `pre-commit.ts` (which is over the max-lines ceiling) as a
 * sibling module — the same split `claude-hooks-compile-regen.ts` (mt#2977)
 * uses. `pre-commit.ts`'s `runDockerfileBunBuildRegen` / `runBunBuildSyncCheck`
 * are thin wrappers that inject their `this`-bound git runner + logger.
 *
 * Two steps, two shapes, for the reason spelled out in
 * `scripts/check-bun-build-sync.ts`'s header: the Dockerfile's `bun build`
 * line is a comment-delimited block that can be safely regenerated in place
 * (same auto-fix-and-restage shape as the Dockerfile workspace-COPY step,
 * mt#2621); package.json's `scripts.build` is a flat JSON string that isn't,
 * so it's a blocking check instead.
 */
import type { HookResult } from "./pre-commit";

/** Injected dependencies (the `this`-bound git runner + logger from PreCommitHook). */
export interface BunBuildSyncDeps {
  projectRoot: string;
  /** Run `git <args>` and return stdout (PreCommitHook.runGitArgv). */
  runGit: (args: string[]) => Promise<string>;
  /** Emit a CLI log line (log.cli). */
  logLine: (line: string) => void;
  /** Run a shell command (execAsync) — injected so the orchestration is unit-testable. */
  exec: (command: string, options: { cwd: string; timeout: number }) => Promise<unknown>;
}

/**
 * Build the failure result for a Dockerfile bun-build regeneration error
 * (mt#3091). Mirrors `classifyDockerfileWorkspaceCopyRegenError`:
 * `regenerateDockerfileBunBuild` always regenerates (never blocks on
 * ordinary drift), so any thrown error here means the generator script
 * itself failed — most likely the root Dockerfile is missing the
 * generated-block markers, which is a one-time setup gap rather than
 * staleness. Pure + exported for unit testing.
 */
export function classifyDockerfileBunBuildRegenError(error: unknown): {
  logLines: string[];
  message: string;
} {
  const execError = error as { stdout?: string; stderr?: string };
  const detail = (execError.stderr ?? "").trim() || (execError.stdout ?? "").trim();
  const errorDetail = detail || (error instanceof Error ? error.message : String(error));
  const logLines = [
    "❌ Dockerfile bun-build regeneration failed:",
    ...errorDetail.split("\n").map((line) => `   ${line}`),
    "💡 The root Dockerfile is likely missing the generated-block markers — see " +
      "Dockerfile for the expected shape.",
  ];
  return {
    logLines,
    message: `Dockerfile bun-build regeneration failed: ${errorDetail.split("\n")[0]}`,
  };
}

/**
 * Regenerate the root Dockerfile's `RUN bun build ...` line from
 * `scripts/cli-entry.ts`'s canonical `bunBuildArgs()` and re-stage it if
 * changed. Unconditional — no override, no staged-file gate: the generator
 * is a pure function of a fixed source (cli-entry.ts) and a fixed target
 * (root Dockerfile), so there is no narrower condition to gate on.
 */
export async function regenerateDockerfileBunBuild(deps: BunBuildSyncDeps): Promise<HookResult> {
  const { projectRoot, runGit, logLine, exec } = deps;

  try {
    await exec("bun run generate:dockerfile-bun-build", {
      cwd: projectRoot,
      timeout: 15000,
    });
  } catch (error) {
    const result = classifyDockerfileBunBuildRegenError(error);
    for (const line of result.logLines) logLine(line);
    return { success: false, message: result.message, exitCode: 1 };
  }

  let diffStdout: string;
  try {
    diffStdout = await runGit(["diff", "--name-only", "--", "Dockerfile"]);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logLine(`❌ Could not diff the regenerated Dockerfile: ${errMsg}`);
    return {
      success: false,
      message: `Could not diff the regenerated Dockerfile: ${errMsg}`,
      exitCode: 1,
    };
  }

  if (diffStdout.trim().length === 0) {
    return { success: true, message: "Dockerfile bun-build invocation up-to-date", exitCode: 0 };
  }

  try {
    await runGit(["add", "--", "Dockerfile"]);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logLine(`❌ Could not stage the regenerated Dockerfile: ${errMsg}`);
    return {
      success: false,
      message: `Could not stage the regenerated Dockerfile: ${errMsg}`,
      exitCode: 1,
    };
  }

  logLine("✅ Dockerfile bun-build invocation regenerated and staged (was out of date).");
  return {
    success: true,
    message: "Dockerfile bun-build invocation regenerated and staged",
    exitCode: 0,
  };
}

/**
 * Block the commit if package.json's `scripts.build` (or, as a
 * defense-in-depth backstop, the Dockerfile's generated block) diverges
 * from `scripts/cli-entry.ts`'s canonical `bunBuildCommand()`. Does NOT
 * auto-fix — see `scripts/check-bun-build-sync.ts`'s header for why
 * package.json's build script isn't safely auto-rewritable the way the
 * Dockerfile block is.
 */
export async function checkBunBuildSync(deps: BunBuildSyncDeps): Promise<HookResult> {
  const { projectRoot, logLine, exec } = deps;

  try {
    await exec("bun run check:bun-build-sync", {
      cwd: projectRoot,
      timeout: 15000,
    });
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string };
    const detail = (execError.stdout ?? "").trim() || (execError.stderr ?? "").trim();
    const errorDetail = detail || (error instanceof Error ? error.message : String(error));
    logLine("❌ bun-build invocation drift detected:");
    for (const line of errorDetail.split("\n")) logLine(`   ${line}`);
    return {
      success: false,
      message: `bun-build invocation drift detected: ${errorDetail.split("\n")[0]}`,
      exitCode: 1,
    };
  }

  return { success: true, message: "bun-build invocation in sync", exitCode: 0 };
}
