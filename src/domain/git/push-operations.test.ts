import { describe, test, expect } from "bun:test";
import { pushImpl, type PushDependencies } from "./push-operations";

const WORKDIR = "/tmp/work";
const CMD_REV_PARSE_BRANCH = `git -C '/tmp/work' rev-parse --abbrev-ref HEAD`;
const CMD_REV_PARSE_SHORT = `git -C '/tmp/work' rev-parse --short HEAD`;
const CMD_REMOTE = `git -C '/tmp/work' remote`;
const RX_PUSH = /^git -C '\/tmp\/work' push /;

type ExecCall = { command: string };
type Handler = { stdout: string; stderr?: string } | Error;
type HandlerKey = string | RegExp;
type HandlerEntry = [HandlerKey, Handler];

// Anchored / exact matching: keys are either exact strings (matched via
// command === key) or RegExp (matched via key.test(command)). Substring
// matching is intentionally absent so accidental extra flags can't be
// silently absorbed by a handler.
function makeDeps(handlers: HandlerEntry[]): {
  deps: PushDependencies;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const deps: PushDependencies = {
    async execAsync(command: string) {
      calls.push({ command });
      for (const [key, result] of handlers) {
        const matched = typeof key === "string" ? command === key : key.test(command);
        if (matched) {
          if (result instanceof Error) throw result;
          return { stdout: result.stdout, stderr: result.stderr ?? "" };
        }
      }
      throw new Error(`Unhandled exec call: ${command}`);
    },
  };
  return { deps, calls };
}

describe("pushImpl", () => {
  test("is defined and takes 2 parameters", () => {
    expect(pushImpl).toBeDefined();
    expect(pushImpl.length).toBe(2);
  });

  test("throws actionable error on detached HEAD with current SHA", async () => {
    const { deps, calls } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "HEAD\n" }],
      [CMD_REV_PARSE_SHORT, { stdout: "abc1234\n" }],
    ]);

    await expect(pushImpl({ repoPath: WORKDIR }, deps)).rejects.toThrow(
      /Cannot push: HEAD is detached in \/tmp\/work \(currently at abc1234\).*(?:git switch|git checkout -b)/s
    );

    expect(calls.every((c) => c.command !== CMD_REMOTE)).toBe(true);
    expect(calls.every((c) => !RX_PUSH.test(c.command))).toBe(true);
  });

  test("detached-HEAD message omits SHA suffix when rev-parse --short fails", async () => {
    const { deps } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "HEAD\n" }],
      [CMD_REV_PARSE_SHORT, new Error("rev-parse --short failed")],
    ]);

    await expect(pushImpl({ repoPath: WORKDIR }, deps)).rejects.toThrow(
      /Cannot push: HEAD is detached in \/tmp\/work\. /
    );
  });

  test("propagates the original rev-parse error unchanged (preserves type/stack/fields)", async () => {
    class GitExecError extends Error {
      stderr = "fatal: not a git repository (or any of the parent directories)";
      code = 128;
    }
    const original = new GitExecError("Command failed");
    const { deps } = makeDeps([[CMD_REV_PARSE_BRANCH, original]]);

    let caught: unknown;
    try {
      await pushImpl({ repoPath: WORKDIR }, deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(original);
    expect((caught as GitExecError).code).toBe(128);
    expect((caught as GitExecError).stderr).toMatch(/not a git repository/);
  });

  test("propagates the original push error unchanged for unrecognized stderr", async () => {
    class GitExecError extends Error {
      stderr = "fatal: unable to access 'https://example/': SSL connection error";
      code = 128;
    }
    const original = new GitExecError("push failed");
    const { deps } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "feature/x\n" }],
      [CMD_REMOTE, { stdout: "origin\n" }],
      [RX_PUSH, original],
    ]);

    let caught: unknown;
    try {
      await pushImpl({ repoPath: WORKDIR }, deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(original);
    expect((caught as GitExecError).code).toBe(128);
    expect((caught as GitExecError).stderr).toMatch(/SSL connection error/);
  });

  test("rewrites push error to actionable message when stderr contains '[rejected]'", async () => {
    class GitExecError extends Error {
      stderr = "! [rejected]   task/mt-1356 -> task/mt-1356 (non-fast-forward)";
    }
    const { deps } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "task/mt-1356\n" }],
      [CMD_REMOTE, { stdout: "origin\n" }],
      [RX_PUSH, new GitExecError("push failed")],
    ]);

    await expect(pushImpl({ repoPath: WORKDIR }, deps)).rejects.toThrow(
      /Push was rejected by the remote/
    );
  });

  test("rewrites push error to actionable message when stderr contains 'no upstream'", async () => {
    class GitExecError extends Error {
      stderr = "fatal: The current branch has no upstream branch.";
    }
    const { deps } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "task/mt-1356\n" }],
      [CMD_REMOTE, { stdout: "origin\n" }],
      [RX_PUSH, new GitExecError("push failed")],
    ]);

    await expect(pushImpl({ repoPath: WORKDIR }, deps)).rejects.toThrow(
      /No upstream branch is set/
    );
  });

  test("succeeds for normal attached HEAD on a fresh branch", async () => {
    const { deps, calls } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "task/mt-994\n" }],
      [CMD_REMOTE, { stdout: "origin\n" }],
      [RX_PUSH, { stdout: "" }],
    ]);

    const result = await pushImpl({ repoPath: WORKDIR }, deps);

    expect(result).toEqual({ workdir: WORKDIR, pushed: true });
    const pushCall = calls.find((c) => RX_PUSH.test(c.command));
    expect(pushCall?.command).toBe(`git -C '/tmp/work' push 'origin' 'task/mt-994'`);
  });

  test("appends --force when options.force is true", async () => {
    const { deps, calls } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "task/mt-994\n" }],
      [CMD_REMOTE, { stdout: "origin\n" }],
      [RX_PUSH, { stdout: "" }],
    ]);

    await pushImpl({ repoPath: WORKDIR, force: true }, deps);

    const pushCall = calls.find((c) => RX_PUSH.test(c.command));
    expect(pushCall?.command).toBe(`git -C '/tmp/work' push 'origin' 'task/mt-994' --force`);
  });

  test("targets the configured remote when options.remote is non-default", async () => {
    const { deps, calls } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "feature/x\n" }],
      [CMD_REMOTE, { stdout: "origin\nupstream\n" }],
      [RX_PUSH, { stdout: "" }],
    ]);

    await pushImpl({ repoPath: WORKDIR, remote: "upstream" }, deps);

    const pushCall = calls.find((c) => RX_PUSH.test(c.command));
    expect(pushCall?.command).toBe(`git -C '/tmp/work' push 'upstream' 'feature/x'`);
  });

  test("throws when configured remote does not exist", async () => {
    const { deps } = makeDeps([
      [CMD_REV_PARSE_BRANCH, { stdout: "task/mt-994\n" }],
      [CMD_REMOTE, { stdout: "upstream\n" }],
    ]);

    await expect(pushImpl({ repoPath: WORKDIR }, deps)).rejects.toThrow(
      /Remote 'origin' does not exist/
    );
  });

  test("throws when rev-parse returns an empty branch name", async () => {
    const { deps } = makeDeps([[CMD_REV_PARSE_BRANCH, { stdout: "\n" }]]);

    await expect(pushImpl({ repoPath: WORKDIR }, deps)).rejects.toThrow(
      /rev-parse returned an empty branch name/
    );
  });

  test("handles workdir with spaces", async () => {
    const SPACE_WORKDIR = "/tmp/work dir";
    const SP_RP = `git -C '/tmp/work dir' rev-parse --abbrev-ref HEAD`;
    const SP_REMOTE = `git -C '/tmp/work dir' remote`;
    const SP_PUSH = /^git -C '\/tmp\/work dir' push /;

    const { deps, calls } = makeDeps([
      [SP_RP, { stdout: "task/mt-1356\n" }],
      [SP_REMOTE, { stdout: "origin\n" }],
      [SP_PUSH, { stdout: "" }],
    ]);

    const result = await pushImpl({ repoPath: SPACE_WORKDIR }, deps);

    expect(result).toEqual({ workdir: SPACE_WORKDIR, pushed: true });
    const pushCall = calls.find((c) => SP_PUSH.test(c.command));
    expect(pushCall?.command).toBe(`git -C '/tmp/work dir' push 'origin' 'task/mt-1356'`);
  });

  test("handles remote and branch with spaces (shell-arg quoting end-to-end)", async () => {
    const FUNNY_REMOTE = "weird remote";
    const FUNNY_BRANCH = "feature/with space";
    const RP = `git -C '/tmp/work' rev-parse --abbrev-ref HEAD`;
    const REMOTE_LIST = `git -C '/tmp/work' remote`;
    const PUSH = `git -C '/tmp/work' push 'weird remote' 'feature/with space'`;

    const { deps, calls } = makeDeps([
      [RP, { stdout: `${FUNNY_BRANCH}\n` }],
      [REMOTE_LIST, { stdout: `${FUNNY_REMOTE}\n` }],
      [PUSH, { stdout: "" }],
    ]);

    const result = await pushImpl({ repoPath: WORKDIR, remote: FUNNY_REMOTE }, deps);

    expect(result).toEqual({ workdir: WORKDIR, pushed: true });
    const pushCall = calls.find((c) => c.command.startsWith("git -C '/tmp/work' push"));
    expect(pushCall?.command).toBe(PUSH);
  });
});
