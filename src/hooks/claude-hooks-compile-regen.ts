/**
 * claude-hooks compile auto-regeneration (mt#2977).
 *
 * Extracted from `pre-commit.ts` (which is over the max-lines ceiling) as a
 * sibling module — the same split the Dockerfile workspace-COPY regen uses
 * (`workspace-copy-detector.ts`). `pre-commit.ts`'s
 * `runClaudeHooksCompileRegen` is a thin wrapper that injects its
 * `this`-bound git runner + logger.
 *
 * Behavior: when a commit stages `.minsky/hooks/` sources (or their generated
 * `.claude/hooks/` outputs), regenerate `.claude/hooks/*` and re-stage the
 * changed files — the same auto-fix-and-restage shape as the completion-manifest
 * (Step 1b) and Dockerfile workspace-COPY (Step 3c) steps — instead of the
 * block-on-drift shape `runCompileCheck` uses for the sibling targets. Editing
 * a hook source no longer requires a manual `compile --target claude-hooks` +
 * re-commit.
 */
import type { HookResult } from "./pre-commit";

/**
 * True iff any staged file lives under the claude-hooks source tree
 * (`.minsky/hooks/`) or its generated output (`.claude/hooks/`). This is the
 * gate for the regen (mt#2977 SC#2): a commit that doesn't touch hooks pays no
 * compile cost. Staging either the source OR the generated output counts, so a
 * hand-edited output is also reconciled. Pure + exported for unit testing.
 */
export function claudeHooksCompileAffected(stagedFiles: string[]): boolean {
  return stagedFiles.some((f) => f.startsWith(".minsky/hooks/") || f.startsWith(".claude/hooks/"));
}

/**
 * Build the failure result for a claude-hooks compile-regeneration error
 * (mt#2977). Mirrors `classifyDockerfileWorkspaceCopyRegenError`: the regen
 * always runs `compile --target claude-hooks` (never `--check`), so ANY thrown
 * error means the compile command itself failed — re-running the commit will
 * not help until the compile error is fixed (this is NOT ordinary staleness).
 * Pure + exported for unit testing.
 */
export function classifyCompileHooksRegenError(error: unknown): {
  logLines: string[];
  message: string;
} {
  const execError = error as { stdout?: string; stderr?: string };
  // `||` after the first `.trim()`: an EMPTY-string stderr must fall through to
  // stdout (mirrors the sibling classifiers in pre-commit.ts).
  const detail = (execError.stderr ?? "").trim() || (execError.stdout ?? "").trim();
  const errorDetail = detail || (error instanceof Error ? error.message : String(error));
  const logLines = [
    "❌ claude-hooks compile regeneration failed:",
    ...errorDetail.split("\n").map((line) => `   ${line}`),
    "💡 Fix the compile error above and retry the commit. This is a compile failure, " +
      "not staleness — re-running the commit will NOT help until the compile error is fixed.",
  ];
  return {
    logLines,
    message: `claude-hooks compile regeneration failed: ${errorDetail.split("\n")[0]}`,
  };
}

/** Injected dependencies (the `this`-bound git runner + logger from PreCommitHook). */
export interface ClaudeHooksRegenDeps {
  projectRoot: string;
  /** Run `git <args>` and return stdout (PreCommitHook.runGitArgv). */
  runGit: (args: string[]) => Promise<string>;
  /** Emit a CLI log line (log.cli). */
  logLine: (line: string) => void;
  /** Run a shell command (execAsync) — injected so the orchestration is unit-testable. */
  exec: (command: string, options: { cwd: string; timeout: number }) => Promise<unknown>;
}

function nonEmptyLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Regenerate + re-stage `.claude/hooks/*` when this commit stages hooks
 * sources/outputs. Returns a `HookResult` (success unless a git/compile step
 * fails loudly). Injectable deps make the orchestration unit-testable without
 * spawning real git/compile.
 */
export async function regenerateStagedClaudeHooks(deps: ClaudeHooksRegenDeps): Promise<HookResult> {
  const { projectRoot, runGit, logLine } = deps;

  let stagedFiles: string[];
  try {
    stagedFiles = nonEmptyLines(
      await runGit(["diff", "--cached", "--name-only", "--diff-filter=ACM"])
    );
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logLine(`❌ Could not read staged files for claude-hooks regen: ${errMsg}`);
    return {
      success: false,
      message: `Could not read staged files for claude-hooks regen: ${errMsg}`,
      exitCode: 1,
    };
  }

  if (!claudeHooksCompileAffected(stagedFiles)) {
    return {
      success: true,
      message: "No claude-hooks sources staged — skipping regen",
      exitCode: 0,
    };
  }

  try {
    await deps.exec("bun run src/cli.ts compile --target claude-hooks", {
      cwd: projectRoot,
      timeout: 30000,
    });
  } catch (error) {
    const result = classifyCompileHooksRegenError(error);
    for (const line of result.logLines) logLine(line);
    return { success: false, message: result.message, exitCode: 1 };
  }

  let changedFiles: string[];
  try {
    changedFiles = nonEmptyLines(await runGit(["diff", "--name-only", "--", ".claude/hooks/"]));
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logLine(`❌ Could not diff regenerated claude-hooks output: ${errMsg}`);
    return {
      success: false,
      message: `Could not diff regenerated claude-hooks output: ${errMsg}`,
      exitCode: 1,
    };
  }

  if (changedFiles.length === 0) {
    return { success: true, message: "claude-hooks output up-to-date", exitCode: 0 };
  }

  try {
    await runGit(["add", "--", ...changedFiles]);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logLine(`❌ Could not stage regenerated claude-hooks output: ${errMsg}`);
    return {
      success: false,
      message: `Could not stage regenerated claude-hooks output: ${errMsg}`,
      exitCode: 1,
    };
  }

  logLine(
    `✅ claude-hooks output regenerated and staged (was out of date): ${changedFiles.join(", ")}`
  );
  return { success: true, message: "claude-hooks output regenerated and staged", exitCode: 0 };
}
