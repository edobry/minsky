import { describe, test, expect } from "bun:test";
import { pushImpl, type PushDependencies } from "./push-operations";

const WORKDIR = "/tmp/work";
const CMD_SYMREF = `git -C ${WORKDIR} symbolic-ref -q --short HEAD`;
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

  test("throws actionable error when symbolic-ref exits non-zero (detached HEAD)", async () => {
    const { deps, calls } = makeDeps({
      [CMD_SYMREF]: new Error("fatal: ref HEAD is not a symbolic ref"),
    });

    await expect(pushImpl({ repoPath: WORKDIR }, deps)).rejects.toThrow(
      /Cannot push: HEAD is detached or unborn in \/tmp\/work/
    );
    await expect(pushImpl({ repoPath: WORKDIR }, deps)).rejects.toThrow(
      /git switch|git checkout -b/
    );

    expect(calls.every((c) => !c.command.includes(CMD_REMOTE))).toBe(true);
    expect(calls.every((c) => !c.command.includes(CMD_PUSH_PREFIX))).toBe(true);
  });

  test("throws actionable error when symbolic-ref returns empty (unborn HEAD)", async () => {
    const { deps } = makeDeps({
      [CMD_SYMREF]: { stdout: "\n" },
    });

    await expect(pushImpl({ repoPath: WORKDIR }, deps)).rejects.toThrow(
      /Cannot push: HEAD is detached or unborn in \/tmp\/work/
    );
  });

  test("error message does not reference product-specific branch naming", async () => {
    const { deps } = makeDeps({
      [CMD_SYMREF]: new Error("fatal: ref HEAD is not a symbolic ref"),
    });

    await expect(pushImpl({ repoPath: WORKDIR }, deps)).rejects.not.toThrow(/task\/mt-/);
  });

  test("succeeds for normal attached HEAD on a fresh branch", async () => {
    const { deps, calls } = makeDeps({
      [CMD_SYMREF]: { stdout: "task/mt-994\n" },
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
      [CMD_SYMREF]: { stdout: "task/mt-994\n" },
      [CMD_REMOTE]: { stdout: "origin\n" },
      [CMD_PUSH_PREFIX]: { stdout: "" },
    });

    await pushImpl({ repoPath: WORKDIR, force: true }, deps);

    const pushCall = calls.find((c) => c.command.includes(" push "));
    expect(pushCall?.command).toBe(`${CMD_PUSH_PREFIX} origin task/mt-994 --force`);
  });

  test("targets the configured remote when options.remote is non-default", async () => {
    const { deps, calls } = makeDeps({
      [CMD_SYMREF]: { stdout: "feature/x\n" },
      [CMD_REMOTE]: { stdout: "origin\nupstream\n" },
      [CMD_PUSH_PREFIX]: { stdout: "" },
    });

    await pushImpl({ repoPath: WORKDIR, remote: "upstream" }, deps);

    const pushCall = calls.find((c) => c.command.includes(" push "));
    expect(pushCall?.command).toBe(`${CMD_PUSH_PREFIX} upstream feature/x`);
  });

  test("throws when configured remote does not exist", async () => {
    const { deps } = makeDeps({
      [CMD_SYMREF]: { stdout: "task/mt-994\n" },
      [CMD_REMOTE]: { stdout: "upstream\n" },
    });

    await expect(pushImpl({ repoPath: WORKDIR }, deps)).rejects.toThrow(
      /Remote 'origin' does not exist/
    );
  });
});
