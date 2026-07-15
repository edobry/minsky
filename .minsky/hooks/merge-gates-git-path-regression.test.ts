#!/usr/bin/env bun
/**
 * Regression test for mt#2810 — the `ENOENT: posix_spawn 'git'` crash that
 * took down all four `session_pr_merge` PreToolUse gates on 2026-07-14 and
 * 2026-07-15, silently permitting merges with zero gate enforcement.
 *
 * Unlike `types.test.ts`'s unit-level coverage of `resolveGitBinary` and the
 * `execSync`/`execWithPath` crash-safety wrapper (dependency-injected fakes,
 * mocked `Bun.spawnSync`), THIS file exercises the actual mt#2810 acceptance
 * test literally: "Run a gate hook with PATH=/nonexistent in a test harness
 * -> gate still resolves git (or emits the structured degradation warning),
 * never a raw ENOENT stack" — for each of the four real gate entrypoint
 * scripts, spawned as genuine subprocesses with a broken PATH, exactly as
 * Claude Code itself spawns them.
 *
 * ## Why a real subprocess, not a mocked unit test
 *
 * The bug was an UNCAUGHT synchronous throw escaping the hook's top-level
 * `if (import.meta.main)` block. A unit test that imports the hook module
 * and calls its internal functions never exercises that top-level
 * entrypoint or Bun's actual process-level error handling — only a real
 * subprocess spawn proves the whole hook process doesn't crash.
 *
 * ## Why a scratch repo with no `origin` remote (not this session's repo)
 *
 * Using a real repo (real GitHub origin) would make `deriveRepoFromGit`
 * succeed and drive the gate into making live `gh api` network calls —
 * slow, flaky, and not what this test is about. A throwaway git repo with
 * NO origin remote makes `git remote get-url origin` fail FAST (no
 * network) while still genuinely spawning `git` under the broken PATH —
 * exactly the code path this bug lived in (`deriveRepoFromGit` ->
 * `execWithPath` -> `Bun.spawnSync(["git", ...])`). Each gate's fail-open
 * "could not derive owner/repo" warning path (or, for
 * require-review-before-merge.ts post-mt#2810, its now-loud warning) is
 * hit deterministically and near-instantly.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
// eslint-disable-next-line custom/no-real-fs-in-tests -- real-subprocess integration test by design (see module comment above): proves the ACTUAL hook entrypoints don't crash, which needs a real git repo + a real spawned process
import { mkdtempSync, rmSync } from "node:fs";
// eslint-disable-next-line custom/no-real-fs-in-tests -- same justification: a real OS temp dir, not a mock path, is required for the real subprocess spawn below
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOKS_DIR = import.meta.dir;

const GATE_ENTRYPOINTS = [
  "require-review-before-merge.ts",
  "require-execution-evidence-before-merge.ts",
  "require-deploy-verification-before-merge.ts",
  "block-out-of-band-merge.ts",
] as const;

/** Bun's own uncaught-exception reporter signature (verified empirically —
 * see the mt#2810 PR body's "Execution evidence" section for the repro). A
 * raw crash always includes this stack-frame marker; our caught-and-logged
 * degradation path never does. */
const RAW_CRASH_STACK_MARKER = "loadAndEvaluateModule";
/** Bun's crash-report version banner — only appears on an actual uncaught
 * top-level exception, never on a plain `console.error(...)` call. */
const RAW_CRASH_BANNER_RE = /Bun v[\d.]+ \(/;

let scratchRepo: string;

beforeAll(() => {
  // Setup uses the TEST process's own (real, unrestricted) PATH — only the
  // spawned hook subprocess below gets the broken PATH under test.
  scratchRepo = mkdtempSync(join(tmpdir(), "mt2810-git-path-"));
  const init = Bun.spawnSync(["git", "init", "--quiet"], { cwd: scratchRepo });
  if (init.exitCode !== 0) {
    throw new Error(
      `test setup failed: \`git init\` in scratch repo exited ${init.exitCode} — ` +
        `${init.stderr?.toString() ?? ""}`
    );
  }
  // Deliberately no `origin` remote — see module comment above.
});

afterAll(() => {
  // eslint-disable-next-line custom/no-real-fs-in-tests -- cleaning up the real scratch repo created in beforeAll above
  if (scratchRepo) rmSync(scratchRepo, { recursive: true, force: true });
});

interface GateRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn a gate hook exactly as Claude Code would — feed it JSON on stdin,
 * read stdout/stderr — but with the subprocess's OWN `PATH` broken. The
 * hardcoded `/opt/homebrew/bin:/usr/local/bin` prefix in `execWithPath`
 * plus the mt#2810 `resolveGitBinary` fallback list are both independent
 * of this env var, so this genuinely simulates "PATH doesn't contain git"
 * without needing to strip every other env var the hook process needs to
 * even start.
 */
function runGateWithBrokenPath(hookFilename: string): GateRunResult {
  const hookPath = join(HOOKS_DIR, hookFilename);
  const input = {
    session_id: "mt2810-test-session",
    cwd: scratchRepo,
    hook_event_name: "PreToolUse",
    tool_name: "mcp__minsky__session_pr_merge",
    tool_input: { task: "mt#99999999" },
  };
  const result = Bun.spawnSync([process.execPath, "run", hookPath], {
    cwd: scratchRepo,
    stdin: Buffer.from(JSON.stringify(input)),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: "/mt2810-nonexistent-path-for-testing",
      CLAUDE_PROJECT_DIR: scratchRepo,
    },
    timeout: 15000,
  });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
  };
}

describe("merge-gate entrypoints survive PATH=/nonexistent (mt#2810 regression)", () => {
  for (const hookFilename of GATE_ENTRYPOINTS) {
    it(`${hookFilename} never crashes with a raw ENOENT stack`, () => {
      const result = runGateWithBrokenPath(hookFilename);

      // The core invariant: the hook process itself must never crash. All
      // four gates are documented fail-open, so a healthy run always exits
      // 0 here (no PR exists for the bogus task, or repo derivation itself
      // fails against the origin-less scratch repo — either way, fail-open
      // + exit 0, never a nonzero crash exit).
      expect(result.exitCode).toBe(0);

      // Never the raw Bun uncaught-exception signature — this is the exact
      // shape mt#2810's incident produced pre-fix (verified empirically:
      // `Bun.spawnSync(["git", ...], { env: { PATH: "/nonexistent" } })`
      // throws synchronously and, uncaught, produces exactly this marker +
      // banner + exit code 1).
      expect(result.stderr).not.toContain(RAW_CRASH_STACK_MARKER);
      expect(result.stderr).not.toMatch(RAW_CRASH_BANNER_RE);

      // stdout, if present, must be valid JSON (the hook's structured
      // HookOutput contract) — never a stray partial-write from a process
      // that crashed mid-output.
      const trimmedStdout = result.stdout.trim();
      if (trimmedStdout.length > 0) {
        expect(() => JSON.parse(trimmedStdout)).not.toThrow();
      }
    });
  }

  it("git itself resolves under the broken PATH (fallback resolution, not luck)", () => {
    // Direct proof that `resolveGitBinary`'s fallback path is what saved
    // the day here, not "the command silently never ran." Running `git
    // rev-parse --is-inside-work-tree` in the scratch repo under the same
    // broken-PATH subprocess conditions must still succeed (exit 0) —
    // proving `git` genuinely spawned and executed, not merely that the
    // hook happened to exit early before reaching the git call.
    const result = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `
        const { execWithPath } = await import(${JSON.stringify(join(HOOKS_DIR, "types.ts"))});
        const r = execWithPath(["git", "rev-parse", "--is-inside-work-tree"], { cwd: ${JSON.stringify(scratchRepo)} });
        process.stdout.write(JSON.stringify(r));
        `,
      ],
      {
        cwd: scratchRepo,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PATH: "/mt2810-nonexistent-path-for-testing" },
        timeout: 10000,
      }
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.toString().trim()) as {
      exitCode: number;
      stdout: string;
    };
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout.trim()).toBe("true");
  });
});
