/**
 * Wiring tests for mt#3406 — the STEPS, not just the helper.
 *
 * PR #2480 R1 (BLOCKING): the first round asserted `describeSubprocessFailure`
 * in isolation, which proves the helper's logic and nothing about whether the
 * `catch` branches actually call it with the right budget. That is the
 * production-wiring gap `/implement-task` §7 item 8 names explicitly — "helper
 * unit tests are NOT production-wiring evidence". The acceptance tests are
 * written in terms of the steps ("a simulated timed-out rejection IN THE
 * FORMATTER STEP"), so they belong here.
 *
 * These inject `PreCommitHook`'s `exec` seam rather than module-mocking
 * `child_process`. The mock approach was tried first and abandoned: it only
 * binds if this module has not already been imported, so the tests passed in
 * isolation and failed in a directory run — order-dependent, which is worse
 * than no test at all.
 */
/* eslint-disable custom/no-real-fs-in-tests -- the ESLint step queries git for the staged set through `execGitWithTimeout`, which does NOT go through the injected exec seam. Giving it a real one-file git repo is what makes AT2 a genuine step-level assertion instead of one that passes on the git call failing; a per-run mkdtemp keeps the rule's fixed-path race from applying. */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PreCommitHook } from "./pre-commit";

/** The fields of a Node subprocess rejection the steps read. */
interface FakeFailure {
  killed: boolean;
  signal?: string;
  stdout?: string;
  stderr?: string;
}

/** The private step methods, reached for wiring assertions. */
interface StepSurface {
  runCodeFormatting: () => Promise<{ success: boolean; message: string }>;
  runTypeCheck: () => Promise<{ success: boolean; message: string }>;
  runESLintValidation: () => Promise<{ success: boolean; message: string }>;
}

/**
 * A hook whose subprocesses always fail in the given shape — except the git
 * staged-set query, which must succeed or the ESLint step returns before it
 * ever reaches the lint call, and the assertion would pass for the wrong reason.
 */
/**
 * A real one-file git repo with a staged `.ts` file.
 *
 * Only the ESLint step needs it: it resolves the staged set via
 * `execGitWithTimeout`, which reaches `child_process` directly rather than
 * through the injected seam. Without a real repo that call fails and the step's
 * outer catch relabels THAT — the assertion would pass while testing nothing
 * about a lint timeout. (Observed while writing this: the failure was
 * `ENOENT … posix_spawn '/bin/sh'` from a fixture path that did not exist.)
 */
let repoRoot: string;

beforeAll(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "mt3406-precommit-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoRoot });
  git("init", "--quiet");
  writeFileSync(join(repoRoot, "staged.ts"), "export const x = 1;\n");
  git("add", "staged.ts");
});

afterAll(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function hookThatFailsWith(failure: FakeFailure): StepSurface {
  const exec = (async (command: string) => {
    const err = new Error(`Command failed: ${command}`) as Error & FakeFailure;
    Object.assign(err, failure);
    throw err;
  }) as unknown as ConstructorParameters<typeof PreCommitHook>[1];

  return new PreCommitHook(repoRoot, exec) as unknown as StepSurface;
}

const TIMED_OUT: FakeFailure = { killed: true, signal: "SIGTERM" };

describe("pre-commit steps relabel a killed subprocess (mt#3406 wiring)", () => {
  // AT1 — the formatter step itself, not the helper.
  test("AT1: the formatter step reports a timeout as a timeout, naming its 240s budget", async () => {
    const result = await hookThatFailsWith(TIMED_OUT).runCodeFormatting();

    expect(result.success).toBe(false);
    expect(result.message).toContain("timed out");
    expect(result.message).toContain("240s");
    // The pre-fix message was a bare verdict carrying no timeout signal at all.
    expect(result.message).not.toBe("Code formatting failed");
  });

  // AT2 — the ESLint step, reached only after the git staged-set query succeeds.
  test("AT2: the ESLint step reports a timeout as a timeout, naming its own 60s budget", async () => {
    const result = await hookThatFailsWith(TIMED_OUT).runESLintValidation();

    expect(result.success).toBe(false);
    expect(result.message).toContain("timed out");
    // Its OWN budget, not the formatter's — the two must not share a constant.
    expect(result.message).toContain("60s");
    expect(result.message).not.toContain("240s");
  });

  // AT3 — a genuine failure must not be relabelled by either step.
  test("AT3: the formatter step passes a genuine failure through untouched", async () => {
    const result = await hookThatFailsWith({
      killed: false,
      stdout: "prettier: Unexpected token at 3:1",
    }).runCodeFormatting();

    expect(result.success).toBe(false);
    expect(result.message).not.toContain("timed out");
    expect(result.message).not.toContain("out of memory");
    expect(result.message).toContain("Command failed");
  });

  // The shape that blocked this task's own commit, through the real step.
  test("the typecheck step reports a kernel SIGKILL as an environment problem, not type errors", async () => {
    const result = await hookThatFailsWith({
      killed: false,
      signal: "SIGKILL",
      stdout: "",
      stderr: "",
    }).runTypeCheck();

    expect(result.success).toBe(false);
    expect(result.message).toContain("SIGKILL");
    expect(result.message).toContain("out of memory");
    // The claim the step used to make unconditionally.
    expect(result.message).not.toContain("type errors found");
  });

  test("the typecheck step still reports real type errors as type errors", async () => {
    const result = await hookThatFailsWith({
      killed: false,
      stdout: "src/a.ts(3,1): error TS2304: Cannot find name 'foo'.",
    }).runTypeCheck();

    expect(result.success).toBe(false);
    expect(result.message).not.toContain("out of memory");
    expect(result.message).not.toContain("timed out");
  });
});
