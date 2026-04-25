import { describe, test, expect } from "bun:test";
import { pushImpl, type PushDependencies } from "./push-operations";

const WORKDIR = "/tmp/work";
const CMD_REV_PARSE = `git -C ${WORKDIR} rev-parse --abbrev-ref HEAD`;
const CMD_REMOTE = `git -C ${WORKDIR} remote`;
const CMD_PUSH_PREFIX = `git -C ${WORKDIR} push`;

type ExecCall = { command: string };

function makeDeps(handlers: Record<string, { stdout: string; stderr?: string } | Error>): {
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

  test("throws actionable detached-HEAD error when rev-parse returns 'HEAD'", async () => {
    const { deps, calls } = makeDeps({
      [CMD_REV_PARSE]: { stdout: "HEAD\n" },
    });

    await expect(pushImpl({ repoPath: WORKDIR }, deps)).rejects.toThrow(
      /Cannot push: HEAD is detached in \/tmp\/work/
    );
    await expect(pushImpl({ repoPath: WORKDIR }, deps)).rejects.toThrow(/git checkout/);

    // Critically: must NOT have proceeded to validate remotes or build push cmd
    expect(calls.every((c) => !c.command.includes(CMD_REMOTE))).toBe(true);
    expect(calls.every((c) => !c.command.includes(CMD_PUSH_PREFIX))).toBe(true);
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

  test("throws when configured remote does not exist", async () => {
    const { deps } = makeDeps({
      [CMD_REV_PARSE]: { stdout: "task/mt-994\n" },
      [CMD_REMOTE]: { stdout: "upstream\n" },
    });

    await expect(pushImpl({ repoPath: WORKDIR }, deps)).rejects.toThrow(
      /Remote 'origin' does not exist/
    );
  });
});
