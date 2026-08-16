/**
 * `sessionPr` actually PUTS `headSha` on the result it returns (mt#4046, PR #3021 R1).
 *
 * The sibling test (`pr-command-head-sha.test.ts`) covers `resolvePrHeadSha` in
 * isolation. That is not enough, and the reviewer was right to say so: a helper
 * with green tests and no wiring into the production result is the exact shape of
 * mt#1071 and mt#2416, where a mechanism shipped, passed its own tests, and had
 * zero effect because nothing called it. What a caller consumes is the RESULT
 * object, so that is what this asserts.
 *
 * `sessionPrImpl` is injected (a defaulted dependency) rather than patched, so
 * the assembly step is observable without reaching into a module import.
 */
import { describe, expect, test } from "bun:test";
import { sessionPr } from "./pr-command";
import type { SessionPrDependencies } from "./pr-command";
import type { SessionPrResult } from "../types";

const HEAD_SHA = "020e9022887c2d52b8c64c5d40d29d49d48ee5c8";
const WORKDIR = "/sessions/mt-4046";

function buildDeps(
  overrides: { execInRepository?: (workdir: string, command: string) => Promise<string> } = {}
): SessionPrDependencies {
  const sessionRecord = {
    sessionId: "sess-1",
    taskId: "mt#4046",
    repoName: "edobry/minsky",
    branch: "task/mt-4046",
  };

  return {
    sessionDB: {
      getSession: async () => sessionRecord,
      getSessionWorkdir: async () => WORKDIR,
      updateSession: async () => undefined,
    } as unknown as SessionPrDependencies["sessionDB"],
    gitService: {
      execInRepository: overrides.execInRepository ?? (async () => `${HEAD_SHA}\n`),
    } as unknown as SessionPrDependencies["gitService"],
    sessionPrImpl: (async () =>
      ({
        prBranch: "task/mt-4046",
        baseBranch: "main",
        url: "https://github.com/edobry/minsky/pull/3021",
        statusTransition: { attempted: false, reason: "test" },
      }) as unknown as SessionPrResult) as SessionPrDependencies["sessionPrImpl"],
  };
}

describe("sessionPr result wiring (mt#4046)", () => {
  test("returns headSha, read from the session workdir after the PR is prepared", async () => {
    const seen: Array<{ workdir: string; command: string }> = [];
    const result = await sessionPr(
      { session: "sess-1", title: "t" } as Parameters<typeof sessionPr>[0],
      buildDeps({
        execInRepository: async (workdir, command) => {
          seen.push({ workdir, command });
          return `${HEAD_SHA}\n`;
        },
      })
    );

    expect(result.headSha).toBe(HEAD_SHA);
    // Read from the SESSION's workdir — a sha resolved anywhere else would be
    // some other branch's head and worse than none.
    expect(seen).toEqual([{ workdir: WORKDIR, command: "git rev-parse HEAD" }]);
  });

  test("still returns the PR result when the head sha cannot be read", async () => {
    // The PR exists by then. `headSha` absent means "unknown"; it must not take
    // the rest of the result down with it.
    const result = await sessionPr(
      { session: "sess-1", title: "t" } as Parameters<typeof sessionPr>[0],
      buildDeps({
        execInRepository: async () => {
          throw new Error("fatal: not a git repository");
        },
      })
    );

    expect(result.headSha).toBeUndefined();
    expect(result.url).toBe("https://github.com/edobry/minsky/pull/3021");
    expect(result.prBranch).toBe("task/mt-4046");
  });
});
