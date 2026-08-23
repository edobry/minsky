/**
 * `resolvePrHeadSha` — the PR head sha `session_pr_create` now returns (mt#4046).
 *
 * The defect it closes: PR creation pushes a head of its own (a pre-PR session
 * update runs first), so the `commitHash` the caller holds from `session_commit`
 * is already stale. With no sha in the result, the caller had nothing correct to
 * pass to `session_pr_wait-for-review`'s `expectedHeadSha`, and the watcher spent
 * its whole timeout suppressing a real review as `push-not-landed`. Five sessions
 * in five days (PRs #2920, #2966, #2980, #3000, #3013).
 *
 * The read is best-effort ON PURPOSE — the PR already exists when it runs — so
 * the failure path returning `undefined` rather than throwing is a behavior worth
 * pinning, not an implementation detail.
 */
import { describe, expect, test } from "bun:test";
import { resolvePrHeadSha } from "./pr-command";

const HEAD_SHA = "37d9f49af08dfab45ca61049652d7d8c7f240f6a";

describe("resolvePrHeadSha (mt#4046)", () => {
  test("returns the head sha, trimmed of git's trailing newline", async () => {
    const calls: Array<{ workdir: string; command: string }> = [];
    const sha = await resolvePrHeadSha(async (workdir, command) => {
      calls.push({ workdir, command });
      return `${HEAD_SHA}\n`;
    }, "/sessions/abc");

    expect(sha).toBe(HEAD_SHA);
    expect(calls).toEqual([{ workdir: "/sessions/abc", command: "git rev-parse HEAD" }]);
  });

  test("returns undefined instead of throwing when the read fails", async () => {
    // The PR exists by the time this runs. Propagating the error would fail a
    // completed PR creation over a diagnostic — strictly worse than not knowing.
    const sha = await resolvePrHeadSha(async () => {
      throw new Error("fatal: not a git repository");
    }, "/sessions/abc");

    expect(sha).toBeUndefined();
  });

  test("returns undefined for empty output rather than an empty-string sha", async () => {
    // An empty string would be passed on as `expectedHeadSha` and rejected by the
    // wait's own validation — a confusing failure two calls downstream. Absent is
    // the honest answer, and it means "unknown", never "unchanged".
    const sha = await resolvePrHeadSha(async () => "   \n", "/sessions/abc");

    expect(sha).toBeUndefined();
  });
});
