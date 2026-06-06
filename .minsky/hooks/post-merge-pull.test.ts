import { describe, expect, it } from "bun:test";
import { runHook } from "./post-merge-pull";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type ExecResult = { exitCode: number; stdout: string; stderr: string; timedOut?: boolean };

/** Build a stub exec that returns responses sequentially by call order. */
function makeExec(responses: ExecResult[]): (cmd: string[], opts?: { cwd?: string }) => ExecResult {
  let callIndex = 0;
  return (_cmd: string[], _opts?: { cwd?: string }) => {
    const response = responses[callIndex] ?? { exitCode: 0, stdout: "", stderr: "" };
    callIndex++;
    return response;
  };
}

const SHA_A = "abc1234567890";
const SHA_B = "def9876543210";

const DIRTY_STATUS = " M scripts/cli-entry.ts\n";
const STASH_SAVED = "Saved working directory";

// ---------------------------------------------------------------------------
// Failure cases
// ---------------------------------------------------------------------------

describe("runHook — stale-lock failure", () => {
  it("exits 1 and writes stale-lock recovery hint to stderr", () => {
    const staleLockStderr =
      "fatal: Unable to create '/path/to/project/.git/index.lock': File exists.\n\n" +
      "Another git process seems to be running in this repository, e.g.\n" +
      "an editor opened by 'git commit'. Please make sure all processes\n" +
      "are terminated then try again.";

    const stderrMessages: string[] = [];
    const exitCodes: number[] = [];

    const exec = makeExec([
      { exitCode: 0, stdout: SHA_A, stderr: "" }, // rev-parse HEAD (before)
      { exitCode: 0, stdout: "", stderr: "" }, // git status --porcelain (clean)
      { exitCode: 1, stdout: "", stderr: staleLockStderr }, // git pull
    ]);

    runHook(
      exec,
      "/fake/project",
      (msg) => stderrMessages.push(msg),
      (code) => exitCodes.push(code)
    );

    expect(exitCodes).toEqual([1]);
    const combinedStderr = stderrMessages.join("");
    expect(combinedStderr).toContain("Stale `.git/index.lock`");
    expect(combinedStderr).toContain("rm .git/index.lock");
  });

  it("fires the stale-lock hint when stderr contains only ONE marker (mt#2304 R1: some, not every)", () => {
    // Real git emits ONE of the marker phrases, not both. Under the old
    // `every` logic this single-marker stderr would NOT trigger the hint.
    const singleMarkerStderr =
      "fatal: Unable to create '/path/to/project/.git/index.lock': File exists.";

    const stderrMessages: string[] = [];
    const exitCodes: number[] = [];

    const exec = makeExec([
      { exitCode: 0, stdout: SHA_A, stderr: "" }, // rev-parse HEAD (before)
      { exitCode: 0, stdout: "", stderr: "" }, // git status --porcelain (clean)
      { exitCode: 1, stdout: "", stderr: singleMarkerStderr }, // git pull
    ]);

    runHook(
      exec,
      "/fake/project",
      (msg) => stderrMessages.push(msg),
      (code) => exitCodes.push(code)
    );

    expect(exitCodes).toEqual([1]);
    const combinedStderr = stderrMessages.join("");
    expect(combinedStderr).toContain("Stale `.git/index.lock`");
  });
});

describe("runHook — generic non-zero pull failure", () => {
  it("exits 1 and writes stderr output to stderr writer", () => {
    const genericStderr = "fatal: refusing to merge unrelated histories";

    const stderrMessages: string[] = [];
    const exitCodes: number[] = [];

    const exec = makeExec([
      { exitCode: 0, stdout: SHA_A, stderr: "" }, // rev-parse HEAD (before)
      { exitCode: 0, stdout: "", stderr: "" }, // git status --porcelain (clean)
      { exitCode: 1, stdout: "", stderr: genericStderr }, // git pull
    ]);

    runHook(
      exec,
      "/fake/project",
      (msg) => stderrMessages.push(msg),
      (code) => exitCodes.push(code)
    );

    expect(exitCodes).toEqual([1]);
    const combinedStderr = stderrMessages.join("");
    expect(combinedStderr).toContain("refusing to merge unrelated histories");
  });

  it("does NOT write stale-lock hint for generic failures", () => {
    const genericStderr = "fatal: refusing to merge unrelated histories";

    const stderrMessages: string[] = [];
    const exitCodes: number[] = [];

    const exec = makeExec([
      { exitCode: 0, stdout: SHA_A, stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" }, // git status --porcelain (clean)
      { exitCode: 1, stdout: "", stderr: genericStderr },
    ]);

    runHook(
      exec,
      "/fake/project",
      (msg) => stderrMessages.push(msg),
      (code) => exitCodes.push(code)
    );

    const combinedStderr = stderrMessages.join("");
    expect(combinedStderr).not.toContain("index.lock");
    expect(combinedStderr).not.toContain("rm .git/index.lock");
  });
});

// ---------------------------------------------------------------------------
// Success cases — clean working tree (no stash needed)
// ---------------------------------------------------------------------------

describe("runHook — clean tree, already up to date", () => {
  it("exits 0 and does not write anything user-facing to stderr", () => {
    const stderrMessages: string[] = [];
    const exitCodes: number[] = [];

    const exec = makeExec([
      { exitCode: 0, stdout: SHA_A, stderr: "" }, // rev-parse HEAD (before)
      { exitCode: 0, stdout: "", stderr: "" }, // git status --porcelain (clean)
      { exitCode: 0, stdout: "", stderr: "" }, // git pull (Already up to date)
      { exitCode: 0, stdout: SHA_A, stderr: "" }, // rev-parse HEAD (after) — same SHA
    ]);

    runHook(
      exec,
      "/fake/project",
      (msg) => stderrMessages.push(msg),
      (code) => exitCodes.push(code)
    );

    expect(exitCodes).toEqual([0]);
    expect(stderrMessages).toHaveLength(0);
  });
});

describe("runHook — clean tree, src/ changed", () => {
  it("writes existing Minsky source code updated warning to stdout", () => {
    const stdoutMessages: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);

    process.stdout.write = (msg: string | Uint8Array) => {
      if (typeof msg === "string") {
        stdoutMessages.push(msg);
      }
      return true;
    };

    const exec = makeExec([
      { exitCode: 0, stdout: SHA_A, stderr: "" }, // rev-parse HEAD (before)
      { exitCode: 0, stdout: "", stderr: "" }, // git status --porcelain (clean)
      { exitCode: 0, stdout: "", stderr: "" }, // git pull (fast-forward)
      { exitCode: 0, stdout: SHA_B, stderr: "" }, // rev-parse HEAD (after) — different SHA
      { exitCode: 0, stdout: "src/foo.ts\nsrc/bar.ts", stderr: "" }, // git diff --name-only
    ]);

    runHook(
      exec,
      "/fake/project",
      (_msg) => {},
      (_code) => {}
    );

    process.stdout.write = originalWrite;

    const combinedStdout = stdoutMessages.join("");
    expect(combinedStdout).toContain("Minsky source code updated by this merge");
  });
});

describe("runHook — clean tree, no src/ changes", () => {
  it("does NOT write Minsky source code warning when only non-src files changed", () => {
    const stdoutMessages: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);

    process.stdout.write = (msg: string | Uint8Array) => {
      if (typeof msg === "string") {
        stdoutMessages.push(msg);
      }
      return true;
    };

    const exec = makeExec([
      { exitCode: 0, stdout: SHA_A, stderr: "" }, // rev-parse HEAD (before)
      { exitCode: 0, stdout: "", stderr: "" }, // git status --porcelain (clean)
      { exitCode: 0, stdout: "", stderr: "" }, // git pull (fast-forward)
      { exitCode: 0, stdout: SHA_B, stderr: "" }, // rev-parse HEAD (after) — different SHA
      { exitCode: 0, stdout: "", stderr: "" }, // git diff --name-only — empty (no src/ changes)
    ]);

    runHook(
      exec,
      "/fake/project",
      (_msg) => {},
      (_code) => {}
    );

    process.stdout.write = originalWrite;

    const combinedStdout = stdoutMessages.join("");
    expect(combinedStdout).not.toContain("Minsky source code updated");
  });
});

// ---------------------------------------------------------------------------
// Dirty working tree — stash+pull+pop
// ---------------------------------------------------------------------------

describe("runHook — dirty tree, stash+pull+pop success", () => {
  it("stashes, pulls, pops, and exits 0", () => {
    const stderrMessages: string[] = [];
    const exitCodes: number[] = [];

    const exec = makeExec([
      { exitCode: 0, stdout: SHA_A, stderr: "" }, // rev-parse HEAD (before)
      { exitCode: 0, stdout: DIRTY_STATUS, stderr: "" }, // git status --porcelain (dirty)
      { exitCode: 0, stdout: STASH_SAVED, stderr: "" }, // git stash
      { exitCode: 0, stdout: "", stderr: "" }, // git pull (fast-forward)
      { exitCode: 0, stdout: "", stderr: "" }, // git stash pop (success)
      { exitCode: 0, stdout: SHA_B, stderr: "" }, // rev-parse HEAD (after)
      { exitCode: 0, stdout: "", stderr: "" }, // git diff --name-only (no src/ changes)
    ]);

    runHook(
      exec,
      "/fake/project",
      (msg) => stderrMessages.push(msg),
      (code) => exitCodes.push(code)
    );

    expect(exitCodes).toEqual([0]);
    expect(stderrMessages).toHaveLength(0);
  });
});

describe("runHook — dirty tree, stash pop conflict", () => {
  it("warns about conflicts and stash entry kept, exits 0 (main was advanced)", () => {
    const stderrMessages: string[] = [];
    const exitCodes: number[] = [];

    const exec = makeExec([
      { exitCode: 0, stdout: SHA_A, stderr: "" }, // rev-parse HEAD (before)
      { exitCode: 0, stdout: DIRTY_STATUS, stderr: "" }, // git status --porcelain (dirty)
      { exitCode: 0, stdout: STASH_SAVED, stderr: "" }, // git stash
      { exitCode: 0, stdout: "", stderr: "" }, // git pull (fast-forward)
      { exitCode: 1, stdout: "", stderr: "CONFLICT in scripts/cli-entry.ts" }, // git stash pop (conflict)
      { exitCode: 0, stdout: SHA_B, stderr: "" }, // rev-parse HEAD (after)
      { exitCode: 0, stdout: "src/mcp/server.ts", stderr: "" }, // git diff --name-only
    ]);

    runHook(
      exec,
      "/fake/project",
      (msg) => stderrMessages.push(msg),
      (code) => exitCodes.push(code)
    );

    expect(exitCodes).toEqual([0]);
    const combinedStderr = stderrMessages.join("");
    expect(combinedStderr).toContain("stash pop had conflicts");
    expect(combinedStderr).toContain("stash entry was kept");
    expect(combinedStderr).toContain("git stash drop");
    expect(combinedStderr).not.toContain("git stash pop");
  });
});

describe("runHook — dirty tree, pull fails, stash restored successfully", () => {
  it("restores stash on pull failure and exits 1", () => {
    const stderrMessages: string[] = [];
    const exitCodes: number[] = [];

    const exec = makeExec([
      { exitCode: 0, stdout: SHA_A, stderr: "" }, // rev-parse HEAD (before)
      { exitCode: 0, stdout: DIRTY_STATUS, stderr: "" }, // git status --porcelain (dirty)
      { exitCode: 0, stdout: STASH_SAVED, stderr: "" }, // git stash
      { exitCode: 1, stdout: "", stderr: "fatal: Not possible to fast-forward" }, // git pull fails
      { exitCode: 0, stdout: "", stderr: "" }, // git stash pop (restore succeeds)
    ]);

    runHook(
      exec,
      "/fake/project",
      (msg) => stderrMessages.push(msg),
      (code) => exitCodes.push(code)
    );

    expect(exitCodes).toEqual([1]);
    const combinedStderr = stderrMessages.join("");
    expect(combinedStderr).toContain("Not possible to fast-forward");
  });
});

describe("runHook — dirty tree, pull fails, stash restore also fails", () => {
  it("warns about stash restore conflict and exits 1", () => {
    const stderrMessages: string[] = [];
    const exitCodes: number[] = [];

    const exec = makeExec([
      { exitCode: 0, stdout: SHA_A, stderr: "" }, // rev-parse HEAD (before)
      { exitCode: 0, stdout: DIRTY_STATUS, stderr: "" }, // git status --porcelain (dirty)
      { exitCode: 0, stdout: STASH_SAVED, stderr: "" }, // git stash
      { exitCode: 1, stdout: "", stderr: "fatal: Not possible to fast-forward" }, // git pull fails
      { exitCode: 1, stdout: "", stderr: "CONFLICT in scripts/cli-entry.ts" }, // git stash pop also fails
    ]);

    runHook(
      exec,
      "/fake/project",
      (msg) => stderrMessages.push(msg),
      (code) => exitCodes.push(code)
    );

    expect(exitCodes).toEqual([1]);
    const combinedStderr = stderrMessages.join("");
    expect(combinedStderr).toContain("stash restoration had conflicts");
    expect(combinedStderr).toContain("stash entry was kept");
    expect(combinedStderr).toContain("git stash drop");
  });
});
