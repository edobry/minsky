/**
 * Regression tests for mt#3606 — the GitHub changeset adapter silently fell
 * back to an empty-string token (`new FallbackTokenProvider("")`) whenever no
 * TokenProvider was injected, no `config.token` was passed, and no
 * `GITHUB_TOKEN`/`GH_TOKEN` env var was set. That empty token flowed straight
 * into `createOctokit("")`, producing a bare unauthenticated Octokit with no
 * error and no warning — the degradation stayed invisible until GitHub's
 * 60/hr IP-scoped rate limit tripped (`API rate limit exceeded for <ip>`),
 * observed live 2026-08-03T20:33Z via `changeset_list`.
 *
 * The fix (packages/domain/src/changeset/adapters/github-adapter.ts):
 *   1. `getOctokit()` now refuses loudly — throws a `GitHubTokenUnavailableError`
 *      (a `MinskyError` subclass) naming the missing credential paths —
 *      instead of constructing an Octokit from an empty token, regardless of
 *      how the empty token was arrived at (injected provider, or the default
 *      env/config resolution). The dedicated subclass also lets
 *      `isAvailable()`'s failure logging attach a structured `reason`
 *      without depending on the error's message wording (PR #2588 R1).
 *   2. The default (non-injected) resolution path now mirrors
 *      `createRepositoryBackend`'s token resolution (`createTokenProvider`),
 *      so a configured `github.serviceAccount` (GitHub App) is picked up —
 *      the same authenticated channel the working PR-tool paths already use
 *      — instead of only ever checking env vars.
 *
 * These tests reach the private `getOctokit()` directly (white-box, same
 * convention the sibling mt#1430 regression file uses for the private
 * `getSessionProvider` resolver) rather than going through `list()`. This is
 * deliberate: `getOctokit()` only *constructs* an `Octokit` instance and does
 * no I/O itself, so testing it directly stays fully network-free. Going
 * through `list()` was tried first and rejected — on the pre-fix adapter it
 * makes a REAL unauthenticated network call to the GitHub API (since a bare
 * empty-token Octokit is a real, working, just-unauthenticated client), which
 * is exactly the bug this task fixes and is not something a unit test should
 * depend on (non-deterministic: succeeds until the real IP rate limit trips,
 * at which point it "passes" for the wrong reason).
 */

import { describe, expect, test } from "bun:test";

import { GitHubChangesetAdapter, GitHubTokenUnavailableError } from "./github-adapter";
import { MinskyError } from "../../errors/index";
import type { Octokit } from "@octokit/rest";
import type { TokenProvider } from "../../auth";

const REPO_URL = "https://github.com/edobry/minsky";

/** White-box accessor for the adapter's private `getOctokit()`. */
function callGetOctokit(adapter: GitHubChangesetAdapter): Promise<Octokit> {
  return (adapter as unknown as { getOctokit: () => Promise<Octokit> }).getOctokit();
}

/** A TokenProvider that always resolves to an empty token — simulates every
 * credential path (injected, config, env, service account) having come up
 * empty, regardless of provenance. */
const EMPTY_TOKEN_PROVIDER: TokenProvider = {
  async getToken() {
    return "";
  },
  async getServiceToken() {
    return "";
  },
  async getUserToken() {
    return "";
  },
  async getServiceIdentity() {
    return null;
  },
  isServiceAccountConfigured() {
    return false;
  },
  isRoleConfigured() {
    return false;
  },
};

describe("GitHubChangesetAdapter empty-token refusal (mt#3606)", () => {
  test("refuses loudly instead of making a bare unauthenticated Octokit when the resolved token is empty", async () => {
    const adapter = new GitHubChangesetAdapter(
      REPO_URL,
      {},
      { tokenProvider: EMPTY_TOKEN_PROVIDER }
    );

    // Assert on the stable, code-level marker (the dedicated error class) —
    // not on the full prose sentence, which is free to be reworded (PR #2588
    // R1: loosen assertions pinned to exact error-message wording).
    await expect(callGetOctokit(adapter)).rejects.toBeInstanceOf(GitHubTokenUnavailableError);
    // The message names every credential path that was checked, per SC2.
    // These substrings are the stable parts — the literal config key /
    // env var names — not full sentences.
    await expect(callGetOctokit(adapter)).rejects.toThrow(/TokenProvider/);
    await expect(callGetOctokit(adapter)).rejects.toThrow(/config\.token/);
    await expect(callGetOctokit(adapter)).rejects.toThrow(/serviceAccount/);
    await expect(callGetOctokit(adapter)).rejects.toThrow(/GITHUB_TOKEN\/GH_TOKEN/);
  });

  test("with no injected provider, no config token, and no env token, construction succeeds but the first token acquisition refuses loudly (not a bare empty-token Octokit)", async () => {
    const originalGithubToken = process.env.GITHUB_TOKEN;
    const originalGhToken = process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;

    try {
      const adapter = new GitHubChangesetAdapter(REPO_URL, {});

      // Construction itself must not throw (mirrors the mt#1430 regression
      // this file's sibling test guards — construction stays deferred).
      expect(adapter.platform).toBe("github-pr");

      // The first token acquisition must fail loudly — either our direct
      // refusal (env-vars-only default resolution, the common case in a bare
      // test process) or, if this shared bun-test process happens to have a
      // GitHub App service account configured via some other test file's
      // `initializeConfiguration()` call, a loud error from the App
      // token-minting path. Either way it must NOT silently resolve to a
      // usable (but unauthenticated) Octokit.
      await expect(callGetOctokit(adapter)).rejects.toThrow(MinskyError);
    } finally {
      if (originalGithubToken !== undefined) process.env.GITHUB_TOKEN = originalGithubToken;
      if (originalGhToken !== undefined) process.env.GH_TOKEN = originalGhToken;
    }
  });
});
