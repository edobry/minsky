import { describe, test, expect } from "bun:test";
import { pushImpl, type PushDependencies } from "./push-operations";

const WORKDIR = "/tmp/work";
const CMD_REV_PARSE = `git -C ${WORKDIR} rev-parse --abbrev-ref HEAD`;
const CMD_REMOTE = `git -C ${WORKDIR} remote`;
const CMD_PUSH_PREFIX = `git -C ${WORKDIR} push`;

type ExecCall = { command: string };
type Handler = { stdout: string; stderr?: string } | Error;

function makeDeps(handlers: Record<string, Handler>): {
  deps: PushDependencies;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const deps: PushDependencies = {
    async execAsync(command: string) {
      calls.push({ command });
      for (const [pattern, result] of Object.entries(handlers)) {
        if (command.includes(pattern)) {
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

  test("throws actionable error on detached HEAD (rev-parse returns literal 'HEAD')", async () => {
    const { deps, calls } = makeDeps({
      [CMD_REV_PARSE]: { stdout: "HEAD\n" },
    });

    await expect(pushImpl({ repoPath: WORKDIR }, deps)).rejects.toThrow(
      /Cannot push: HEAD is detached in \/tmp\/work.*(?:git switch|git checkout -b)/s
    );

    expect(calls.every((c) => !c.command.includes(CMD_REMOTE))).toBe(true);
    expect(calls.every((c) => !c.command.includes(CMD_PUSH_PREFIX))).toBe(true);
  });

  test("propagates the original rev-parse error unchanged (preserves type/stack/fields)", async () => {
    class GitExecError extends Error {
      stderr = "fatal: not a git repository (or any of the parent directories)";
      code = 128;
    }
    const original = new GitExecError("Command failed");
    const { deps } = makeDeps({
      [CMD_REV_PARSE]: original,
    });

    let caught: unknown;
    try {
      await pushImpl({ repoPath: WORKDIR }, deps);
    } catch (e) {
      caught = e;
    }
    // Same object identity — not re-wrapped
    expect(caught).toBe(original);
    // Custom fields preserved
    expect((caught as GitExecError).code).toBe(128);
    expect((caught as GitExecError).stderr).toMatch(/not a git repository/);
  });

  test("succeeds for normal attached HEAD on a fresh branch", async () => {
    const { deps, calls } = makeDeps({
      [CMD_REV_PARSE]: { stdout: "task/mt-994\n" },
      [CMD_REMOTE]: { stdout: "origin\n" },
      [CMD_PUSH_PREFIX]: { stdout: "" },
    });

    const result = await pushImpl({ repoPath: WORKDIR }, deps);

    expect(result).toEqual({ workdir: WORKDIR, pushed: true });
    const pushCall = calls.find((c) => c.command.includes(CMD_PUSH_PREFIX));
    expect(pushCall?.command).toBe(`${CMD_PUSH_PREFIX} origin task/mt-994`);
  });

  test("appends --force when options.force is true", async () => {
    const { deps, calls } = makeDeps({
      [CMD_REV_PARSE]: { stdout: "task/mt-994\n" },
      [CMD_REMOTE]: { stdout: "origin\n" },
      [CMD_PUSH_PREFIX]: { stdout: "" },
    });

    await pushImpl({ repoPath: WORKDIR, force: true }, deps);

    const pushCall = calls.find((c) => c.command.includes(" push "));
    expect(pushCall?.command).toBe(`${CMD_PUSH_PREFIX} origin task/mt-994 --force`);
  });

  test("targets the configured remote when options.remote is non-default", async () => {
    const { deps, calls } = makeDeps({
      [CMD_REV_PARSE]: { stdout: "feature/x\n" },
      [CMD_REMOTE]: { stdout: "origin\nupstream\n" },
      [CMD_PUSH_PREFIX]: { stdout: "" },
    });

    await pushImpl({ repoPath: WORKDIR, remote: "upstream" }, deps);

    const pushCall = calls.find((c) => c.command.includes(" push "));
    expect(pushCall?.command).toBe(`${CMD_PUSH_PREFIX} upstream feature/x`);
  });

  test("throws when configured remote does not exist", async () => {
    const { deps } = makeDeps({
      [CMD_REV_PARSE]: { stdout: "task/mt-994\n" },
      [CMD_REMOTE]: { stdout: "upstream\n" },
    });

    await expect(pushImpl({ repoPath: WORKDIR }, deps)).rejects.toThrow(
      /Remote 'origin' does not exist/
    );
  });

  test("throws when rev-parse returns an empty branch name", async () => {
    const { deps } = makeDeps({
      [CMD_REV_PARSE]: { stdout: "\n" },
    });

    await expect(pushImpl({ repoPath: WORKDIR }, deps)).rejects.toThrow(
      /rev-parse returned an empty branch name/
    );
  });
});
