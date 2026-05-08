import { describe, test, expect } from "bun:test";
import {
  stashImpl,
  stashPopImpl,
  stashListImpl,
  stashDropImpl,
  type StashDependencies,
} from "./stash-operations";

const WORKDIR = "/tmp/work";
const RX_STASH_PUSH = /^git -C '\/tmp\/work' stash push/;
const RX_STASH_POP = /^git -C '\/tmp\/work' stash pop/;
const RX_STASH_LIST = /^git -C '\/tmp\/work' stash list/;
const RX_STASH_DROP = /^git -C '\/tmp\/work' stash drop/;

type ExecCall = { command: string };

function makeDeps(
  handlers: Array<[string | RegExp, { stdout: string; stderr?: string } | Error]>
): { deps: StashDependencies; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const deps: StashDependencies = {
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

// ---------------------------------------------------------------------------
// stashImpl
// ---------------------------------------------------------------------------

describe("stashImpl", () => {
  test("returns stashed=true and a stashRef on success", async () => {
    const { deps } = makeDeps([
      [
        RX_STASH_PUSH,
        { stdout: "Saved working directory and index state stash@{0}: WIP on main\n" },
      ],
    ]);
    const result = await stashImpl({ repoPath: WORKDIR }, deps);
    expect(result.stashed).toBe(true);
    expect(result.stashRef).toBe("stash@{0}");
    expect(result.workdir).toBe(WORKDIR);
  });

  test("returns stashed=false when nothing to stash", async () => {
    const { deps } = makeDeps([[RX_STASH_PUSH, { stdout: "No local changes to save\n" }]]);
    const result = await stashImpl({ repoPath: WORKDIR }, deps);
    expect(result.stashed).toBe(false);
    expect(result.stashRef).toBeNull();
  });

  test("includes -m flag when message provided", async () => {
    const { deps, calls } = makeDeps([
      [RX_STASH_PUSH, { stdout: "Saved working directory and index state stash@{0}: pre-pull\n" }],
    ]);
    await stashImpl({ repoPath: WORKDIR, message: "pre-pull" }, deps);
    expect(calls[0]?.command).toContain("-m 'pre-pull'");
  });

  test("includes path filter when paths provided", async () => {
    const { deps, calls } = makeDeps([
      [RX_STASH_PUSH, { stdout: "Saved working directory and index state stash@{0}: selective\n" }],
    ]);
    await stashImpl({ repoPath: WORKDIR, paths: ["src/foo.ts"] }, deps);
    expect(calls[0]?.command).toContain("-- 'src/foo.ts'");
  });

  test("propagates exec errors unchanged", async () => {
    const err = new Error("git stash failed");
    const { deps } = makeDeps([[RX_STASH_PUSH, err]]);
    await expect(stashImpl({ repoPath: WORKDIR }, deps)).rejects.toBe(err);
  });
});

// ---------------------------------------------------------------------------
// stashPopImpl
// ---------------------------------------------------------------------------

describe("stashPopImpl", () => {
  test("returns popped=true with no conflicts on success", async () => {
    const { deps } = makeDeps([[RX_STASH_POP, { stdout: "Changes applied.\n" }]]);
    const result = await stashPopImpl({ repoPath: WORKDIR }, deps);
    expect(result.popped).toBe(true);
    expect(result.conflicts).toHaveLength(0);
  });

  test("returns popped=false with conflict paths when conflicts occur", async () => {
    class GitExecError extends Error {
      stderr = "CONFLICT (content): Merge conflict in src/foo.ts\n";
      stdout = "";
    }
    const { deps } = makeDeps([[RX_STASH_POP, new GitExecError("stash pop conflict")]]);
    const result = await stashPopImpl({ repoPath: WORKDIR }, deps);
    expect(result.popped).toBe(false);
    expect(result.conflicts.length).toBeGreaterThan(0);
  });

  test("pops specific stash ref when provided", async () => {
    const { deps, calls } = makeDeps([[RX_STASH_POP, { stdout: "Changes applied.\n" }]]);
    await stashPopImpl({ repoPath: WORKDIR, ref: "stash@{2}" }, deps);
    expect(calls[0]?.command).toContain("'stash@{2}'");
  });

  test("propagates unrecognized errors", async () => {
    const err = Object.assign(new Error("stash pop failed"), { stderr: "fatal: unknown error\n" });
    const { deps } = makeDeps([[RX_STASH_POP, err]]);
    await expect(stashPopImpl({ repoPath: WORKDIR }, deps)).rejects.toBe(err);
  });
});

// ---------------------------------------------------------------------------
// stashListImpl
// ---------------------------------------------------------------------------

describe("stashListImpl", () => {
  test("returns empty stashes for empty repo", async () => {
    const { deps } = makeDeps([[RX_STASH_LIST, { stdout: "" }]]);
    const result = await stashListImpl({ repoPath: WORKDIR }, deps);
    expect(result.stashes).toHaveLength(0);
  });

  test("parses stash entries correctly", async () => {
    const output = [
      "stash@{0}|2026-05-01 12:00:00 +0000|On main: pre-pull stash",
      "stash@{1}|2026-04-30 10:00:00 +0000|On feature/x: WIP changes",
    ].join("\n");
    const { deps } = makeDeps([[RX_STASH_LIST, { stdout: output }]]);
    const result = await stashListImpl({ repoPath: WORKDIR }, deps);
    expect(result.stashes).toHaveLength(2);
    expect(result.stashes[0]?.ref).toBe("stash@{0}");
    expect(result.stashes[0]?.branch).toBe("main");
    expect(result.stashes[0]?.message).toBe("pre-pull stash");
    expect(result.stashes[1]?.ref).toBe("stash@{1}");
    expect(result.stashes[1]?.branch).toBe("feature/x");
  });
});

// ---------------------------------------------------------------------------
// stashDropImpl
// ---------------------------------------------------------------------------

describe("stashDropImpl", () => {
  test("throws when confirmDrop is false", async () => {
    const { deps } = makeDeps([]);
    await expect(
      stashDropImpl({ repoPath: WORKDIR, ref: "stash@{0}", confirmDrop: false }, deps)
    ).rejects.toThrow(/confirmDrop: true/);
  });

  test("drops the stash when confirmDrop is true", async () => {
    const { deps, calls } = makeDeps([[RX_STASH_DROP, { stdout: "Dropped stash@{0}\n" }]]);
    const result = await stashDropImpl(
      { repoPath: WORKDIR, ref: "stash@{0}", confirmDrop: true },
      deps
    );
    expect(result.dropped).toBe(true);
    expect(calls[0]?.command).toContain("'stash@{0}'");
  });

  test("propagates exec errors", async () => {
    const err = new Error("stash drop failed");
    const { deps } = makeDeps([[RX_STASH_DROP, err]]);
    await expect(
      stashDropImpl({ repoPath: WORKDIR, ref: "stash@{0}", confirmDrop: true }, deps)
    ).rejects.toBe(err);
  });
});
