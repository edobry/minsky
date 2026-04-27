import { describe, expect, it } from "bun:test";
import { runHook } from "./post-merge-pull";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type ExecResult = { exitCode: number; stdout: string; stderr: string; timedOut?: boolean };

/** Build a stub exec function from a call-by-call response list. */
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
});

describe("runHook — generic non-zero pull failure", () => {
  it("exits 1 and writes stderr output to stderr writer", () => {
    const genericStderr = "fatal: refusing to merge unrelated histories";

    const stderrMessages: string[] = [];
    const exitCodes: number[] = [];

    const exec = makeExec([
      { exitCode: 0, stdout: SHA_A, stderr: "" }, // rev-parse HEAD (before)
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
// Success cases
// ---------------------------------------------------------------------------

describe("runHook — success, already up to date", () => {
  it("exits 0 and does not write anything user-facing to stderr", () => {
    const stderrMessages: string[] = [];
    const exitCodes: number[] = [];

    // before and after are the same SHA — no changes pulled
    const exec = makeExec([
      { exitCode: 0, stdout: SHA_A, stderr: "" }, // rev-parse HEAD (before)
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

describe("runHook — success, src/ changed", () => {
  it("writes existing Minsky source code updated warning to stdout", () => {
    const stdoutMessages: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);

    // Temporarily capture stdout
    process.stdout.write = (msg: string | Uint8Array) => {
      if (typeof msg === "string") {
        stdoutMessages.push(msg);
      }
      return true;
    };

    const exec = makeExec([
      { exitCode: 0, stdout: SHA_A, stderr: "" }, // rev-parse HEAD (before)
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

describe("runHook — success, no src/ changes", () => {
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
