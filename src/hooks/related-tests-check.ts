#!/usr/bin/env bun
/**
 * Spawns scripts/run-related-tests.ts (the mt#2932 fast changed-file-scoped
 * test gate) and reports its pass/fail result. Extracted from
 * src/hooks/pre-commit.ts to keep that file under the `max-lines` lint
 * ceiling -- mirrors the existing pattern of small, focused detector modules
 * (nul-byte-detector.ts, migration-journal-check.ts, deploy-domain-detector.ts,
 * etc.) that pre-commit.ts imports and calls rather than inlining.
 */
export interface RelatedTestsCheckResult {
  success: boolean;
  message: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function runRelatedTestsCheck(projectRoot: string): RelatedTestsCheckResult {
  const proc = Bun.spawnSync(["bun", "scripts/run-related-tests.ts"], {
    cwd: projectRoot,
    env: { ...process.env, AGENT: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const decoder = new TextDecoder();
  const stdout = decoder.decode(proc.stdout);
  const stderr = decoder.decode(proc.stderr);
  const exitCode = proc.exitCode ?? 1;
  return {
    success: exitCode === 0,
    message:
      exitCode === 0
        ? "Fast related-test gate passed"
        : "Fast related-test gate failed (see output above)",
    exitCode,
    stdout,
    stderr,
  };
}
