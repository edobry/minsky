import { describe, test, expect } from "bun:test";
import { pullImpl, type PullDependencies } from "./pull-operations";

const WORKDIR = "/tmp/work";
const RX_PULL = /^git -C '\/tmp\/work' pull --ff-only /;
const ALREADY_UP_TO_DATE = "Already up to date.\n";
const FILE_SKILLS_LOCK = "skills-lock.json";

type Handler = { stdout: string; stderr?: string } | Error;
type HandlerKey = string | RegExp;
type HandlerEntry = [HandlerKey, Handler];
type ExecCall = { command: string };

function makeDeps(handlers: HandlerEntry[]): {
  deps: PullDependencies;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const deps: PullDependencies = {
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

describe("pullImpl", () => {
  test("is defined and takes 2 parameters", () => {
    expect(pullImpl).toBeDefined();
    expect(pullImpl.length).toBe(2);
  });

  test("succeeds on already-up-to-date response", async () => {
    const { deps } = makeDeps([[RX_PULL, { stdout: ALREADY_UP_TO_DATE }]]);
    const result = await pullImpl({ repoPath: WORKDIR }, deps);
    expect(result.workdir).toBe(WORKDIR);
    expect(result.alreadyUpToDate).toBe(true);
  });

  test("succeeds on actual ff-only pull (non-up-to-date)", async () => {
    const { deps } = makeDeps([[RX_PULL, { stdout: "Updating abc1234..def5678\nFast-forward\n" }]]);
    const result = await pullImpl({ repoPath: WORKDIR }, deps);
    expect(result.workdir).toBe(WORKDIR);
    expect(result.alreadyUpToDate).toBe(false);
  });

  test("throws structured error with conflicting file paths when local changes block merge", async () => {
    class GitExecError extends Error {
      stderr = `error: Your local changes to the following files would be overwritten by merge:\n\t${FILE_SKILLS_LOCK}\nPlease commit your changes or stash them before you merge.\nAborting\n`;
      stdout = "";
    }
    const { deps } = makeDeps([[RX_PULL, new GitExecError("pull failed")]]);

    let caught: unknown;
    try {
      await pullImpl({ repoPath: WORKDIR }, deps);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain("Pull blocked");
    expect(msg).toContain(FILE_SKILLS_LOCK);
    expect(msg).toContain("mcp__minsky__git_stash");
    // The conflictingFiles property is attached
    expect((caught as Error & { conflictingFiles: string[] }).conflictingFiles).toContain(
      FILE_SKILLS_LOCK
    );
  });

  test("throws structured error for non-fast-forward rejection", async () => {
    class GitExecError extends Error {
      stderr = "fatal: Not possible to fast-forward, aborting.\n";
      stdout = "";
    }
    const { deps } = makeDeps([[RX_PULL, new GitExecError("pull failed")]]);

    await expect(pullImpl({ repoPath: WORKDIR }, deps)).rejects.toThrow(
      /Pull rejected: cannot fast-forward/
    );
  });

  test("propagates original error for unrecognized stderr", async () => {
    class GitExecError extends Error {
      stderr = "fatal: unable to connect to github.com\n";
      stdout = "";
    }
    const original = new GitExecError("pull failed");
    const { deps } = makeDeps([[RX_PULL, original]]);

    let caught: unknown;
    try {
      await pullImpl({ repoPath: WORKDIR }, deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(original);
  });

  test("uses default remote=origin and branch=main", async () => {
    const { deps, calls } = makeDeps([[RX_PULL, { stdout: ALREADY_UP_TO_DATE }]]);
    await pullImpl({ repoPath: WORKDIR }, deps);
    expect(calls[0]?.command).toContain("'origin' 'main'");
  });

  test("uses configured remote and branch", async () => {
    const { deps, calls } = makeDeps([
      [/^git -C '\/tmp\/work' pull --ff-only 'upstream' 'develop'/, { stdout: ALREADY_UP_TO_DATE }],
    ]);
    await pullImpl({ repoPath: WORKDIR, remote: "upstream", branch: "develop" }, deps);
    expect(calls[0]?.command).toBe(`git -C '/tmp/work' pull --ff-only 'upstream' 'develop'`);
  });

  test("handles multiple conflicting files", async () => {
    const FILE_PKG_LOCK = "package-lock.json";
    class GitExecError extends Error {
      stderr =
        "error: Your local changes to the following files would be overwritten by merge:\n" +
        `\t${FILE_SKILLS_LOCK}\n` +
        `\t${FILE_PKG_LOCK}\n` +
        "Please commit your changes or stash them before you merge.\n";
      stdout = "";
    }
    const { deps } = makeDeps([[RX_PULL, new GitExecError("pull failed")]]);

    let caught: unknown;
    try {
      await pullImpl({ repoPath: WORKDIR }, deps);
    } catch (e) {
      caught = e;
    }
    const files = (caught as Error & { conflictingFiles: string[] }).conflictingFiles;
    expect(files).toContain(FILE_SKILLS_LOCK);
    expect(files).toContain(FILE_PKG_LOCK);
  });
});
