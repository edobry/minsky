/**
 * mt#4342 — the capability probe behind hosted-vs-local classification.
 *
 * `isHostedMcpServer` (src/cli-discriminators.ts) decides whether the MCP
 * server enters hosted mode; this supplies the LOCAL half of that decision.
 * Both signals are required, and every uncertain answer must resolve to
 * "not local" so the guard fails closed — per
 * `docs/architecture/hosted-vs-local-mcp-capabilities.md` (mt#1601), a false
 * allow reaches the raw `git: not found` the guard exists to remove, while a
 * false block only costs a clean "use the local server" message.
 *
 * ## Where the ascent itself is verified
 *
 * PR #3233 R1 (BLOCKING) was that the first draft tested `<startDir>/.git`
 * directly, so a server started anywhere inside a repo other than its root was
 * misclassified hosted. The fix is DELEGATION to {@link isInsideGitWorkTree},
 * which already ascends and already counts the worktree/submodule file form.
 *
 * These tests assert the delegation and the fail-closed algebra with injected
 * collaborators. The ascent's real-filesystem behaviour is verified end-to-end
 * by case 4/4 of `scripts/verify-local-daemon-command-surface.ts`, which starts
 * a real daemon with `--repo <repo>/src` — a directory with no `.git` of its
 * own — and asserts a real `git_status` is served. That belongs in a script
 * rather than here: `custom/no-real-fs-in-tests` forbids touching the real
 * filesystem from a unit test, and stubbing the walk to test the walk would
 * assert the stub.
 */

import { describe, test, expect } from "bun:test";

import { hasLocalGitCapability } from "./git-exec";

const GIT_PRESENT = () => "/usr/bin/git";
const GIT_ABSENT = () => null;

describe("hasLocalGitCapability — mt#4342 both signals required", () => {
  test("git on PATH AND inside a work tree is the local capability", () => {
    expect(
      hasLocalGitCapability("/w/minsky", { whichGit: GIT_PRESENT, insideWorkTree: () => true })
    ).toBe(true);
  });

  test("no git binary is not local, even inside a work tree", () => {
    // The hosted image's state: the bundling deliberately removed runtime git.
    expect(
      hasLocalGitCapability("/app", { whichGit: GIT_ABSENT, insideWorkTree: () => true })
    ).toBe(false);
  });

  test("no work tree is not local, even with git present", () => {
    // The second, independent reason the container classifies hosted — and what
    // keeps an image that later gained `git` from being reclassified.
    expect(
      hasLocalGitCapability("/app", { whichGit: GIT_PRESENT, insideWorkTree: () => false })
    ).toBe(false);
  });

  test("PR #3233 R1: it hands the WHOLE directory to the work-tree check", () => {
    // The regression guard. The finding was that the first draft asked a
    // narrower question than "are we inside a work tree" — it tested one
    // derived path, `<startDir>/.git`. Asserting the exact argument is what
    // pins the delegation: any reintroduced path-derivation shows up here as a
    // changed value rather than as a silently narrower probe.
    const asked: string[] = [];
    hasLocalGitCapability("/w/minsky/src/cockpit", {
      whichGit: GIT_PRESENT,
      insideWorkTree: (dir) => {
        asked.push(dir);
        return true;
      },
    });
    expect(asked).toEqual(["/w/minsky/src/cockpit"]);
  });

  test("the work-tree check is skipped entirely when git is absent", () => {
    // Ordering matters for cost: the container has no git, and the walk would
    // otherwise ascend to the filesystem root on every boot to learn nothing.
    let walked = false;
    hasLocalGitCapability("/app", {
      whichGit: GIT_ABSENT,
      insideWorkTree: () => {
        walked = true;
        return false;
      },
    });
    expect(walked).toBe(false);
  });

  test("a probe that throws fails CLOSED rather than widening the guard", () => {
    expect(
      hasLocalGitCapability("/w/minsky", {
        whichGit: GIT_PRESENT,
        insideWorkTree: () => {
          throw new Error("EACCES");
        },
      })
    ).toBe(false);
  });
});
