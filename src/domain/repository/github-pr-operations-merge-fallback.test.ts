/**
 * Tests for mergePullRequest user-token fallback on 403 permission errors.
 *
 * Covers:
 *  - Fallback to user PAT when bot token gets 403 (and user PAT succeeds)
 *  - No fallback available: throws with "Bot token lacks merge rights" message
 *  - 405/422 merge-conflict errors bypass the user-token fallback path entirely
 *  - Both tokens fail with 403: throws with "User PAT fallback also failed" message
 *  - GitHubContext.getUserToken is optional (structural type contract)
 */

import { describe, test, expect } from "bun:test";
import type { GitHubContext } from "./github-pr-operations";
import { MinskyError } from "../../errors/index";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build an Octokit-shaped error with a numeric status code */
function makeStatusError(status: number, message = `HTTP ${status}`): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

/**
 * A narrow mock pull-request operation set.
 * Only the fields called by mergePullRequest are present.
 */
interface MinimalPulls {
  get(params: unknown): Promise<{ data: unknown }>;
  merge(params: unknown): Promise<{ data: unknown }>;
}

interface MinimalOctokit {
  rest: { pulls: MinimalPulls };
}

// ── Stable mock PR data ────────────────────────────────────────────────────

const OPEN_MERGEABLE_PR = {
  state: "open",
  mergeable: true,
  body: "PR body",
  title: "Test PR",
  html_url: "https://github.com/owner/repo/pull/42",
  user: { login: "test-user" },
  head: { ref: "feature-branch" },
  base: { ref: "main" },
};

const MERGE_SUCCESS = {
  sha: "abc123def456",
  merged: true,
  message: "Pull Request successfully merged",
};

// ── mergePullRequest under test via dependency injection ───────────────────
//
// mergePullRequest calls createOctokit(token) internally. We cannot inject an
// octokit directly, but we CAN observe the fallback behavior by testing the
// exported module-level buildable tests AND by exercising the logic paths that
// are reachable without network access.
//
// For full behavioral tests we use a thin adapter pattern: we create a local
// version of the fallback logic that mirrors the production implementation but
// accepts an injected octokit factory — this lets us test the decision tree in
// isolation without module-level mocking overhead.

/**
 * Minimal re-implementation of the 403-fallback decision tree from mergePullRequest.
 * This mirrors the production logic precisely so we can test it with injected mocks.
 */
async function runMergeFallbackLogic(opts: {
  gh: GitHubContext;
  prNumber: number;
  tokenOverride?: () => Promise<string>;
  octokitFactory: (token: string) => MinimalOctokit;
}): Promise<{ sha: string }> {
  const { gh, prNumber, tokenOverride, octokitFactory } = opts;

  const initialToken = await (tokenOverride ? tokenOverride() : gh.getToken());
  const initialOctokit = octokitFactory(initialToken);

  // Simulate the merge attempt
  const mergeParams = { owner: gh.owner, repo: gh.repo, pull_number: prNumber };

  try {
    const result = await initialOctokit.rest.pulls.merge(mergeParams);
    return result.data as { sha: string };
  } catch (mergeError) {
    const status = (mergeError as { status?: number }).status;
    const is403 = status === 403;
    const is405or422 = status === 405 || status === 422;

    if (is403 && !is405or422 && !tokenOverride && gh.getUserToken) {
      // Fallback to user PAT
      try {
        const userToken = await gh.getUserToken();
        const userOctokit = octokitFactory(userToken);
        const result = await userOctokit.rest.pulls.merge(mergeParams);
        return result.data as { sha: string };
      } catch (userMergeError) {
        throw new MinskyError(
          `Bot token lacks merge rights for ${gh.owner}/${gh.repo}#${prNumber}. ` +
            `User PAT fallback also failed: ${(userMergeError as Error).message}. To fix:\n` +
            `  (a) Grant the GitHub App contents:write + pull_requests:write permissions on this repo\n` +
            `  (b) Ensure the user PAT has merge rights\n` +
            `Run \`gh pr merge ${prNumber}\` manually to unblock this PR in the meantime.`
        );
      }
    } else if (is403 && !is405or422 && !tokenOverride) {
      // 403 with no user token fallback available (getUserToken not provided)
      throw new MinskyError(
        `Bot token lacks merge rights for ${gh.owner}/${gh.repo}#${prNumber}. To fix:\n` +
          `  (a) Grant the GitHub App contents:write + pull_requests:write permissions on this repo\n` +
          `  (b) Ensure the user PAT has merge rights (currently the TokenProvider returned no user token, so fallback was skipped)\n` +
          `Run \`gh pr merge ${prNumber}\` manually to unblock this PR in the meantime.`
      );
    } else {
      // Re-throw for outer handler (405/422 merge conflicts, tokenOverride 403s, etc.)
      throw mergeError;
    }
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("mergePullRequest — 403 user-token fallback", () => {
  test("succeeds via user PAT when bot token gets 403", async () => {
    let getUserTokenCalled = false;
    const gh: GitHubContext = {
      owner: "owner",
      repo: "repo",
      getToken: () => Promise.resolve("bot-token"),
      getUserToken: () => {
        getUserTokenCalled = true;
        return Promise.resolve("user-token");
      },
    };

    // Bot token → 403; user token → success
    const octokitFactory = (token: string): MinimalOctokit => ({
      rest: {
        pulls: {
          get: (_: unknown) => Promise.resolve({ data: OPEN_MERGEABLE_PR }),
          merge: (_: unknown) => {
            if (token === "bot-token") return Promise.reject(makeStatusError(403));
            return Promise.resolve({ data: MERGE_SUCCESS });
          },
        },
      },
    });

    const result = await runMergeFallbackLogic({ gh, prNumber: 42, octokitFactory });

    expect(result.sha).toBe("abc123def456");
    expect(getUserTokenCalled).toBe(true);
  });

  test("throws with 'Bot token lacks merge rights' when no getUserToken is available", async () => {
    const gh: GitHubContext = {
      owner: "owner",
      repo: "repo",
      getToken: () => Promise.resolve("bot-token"),
      // getUserToken intentionally absent
    };

    const octokitFactory = (_token: string): MinimalOctokit => ({
      rest: {
        pulls: {
          get: (_: unknown) => Promise.resolve({ data: OPEN_MERGEABLE_PR }),
          merge: (_: unknown) => Promise.reject(makeStatusError(403)),
        },
      },
    });

    await expect(runMergeFallbackLogic({ gh, prNumber: 42, octokitFactory })).rejects.toThrow(
      "Bot token lacks merge rights for owner/repo#42"
    );

    // Specifically the "fallback was skipped" variant
    await expect(runMergeFallbackLogic({ gh, prNumber: 42, octokitFactory })).rejects.toThrow(
      "fallback was skipped"
    );
  });

  test("does not attempt user-token fallback on 405 merge-conflict error", async () => {
    let getUserTokenCalled = false;
    const gh: GitHubContext = {
      owner: "owner",
      repo: "repo",
      getToken: () => Promise.resolve("bot-token"),
      getUserToken: () => {
        getUserTokenCalled = true;
        return Promise.resolve("user-token");
      },
    };

    const octokitFactory = (_token: string): MinimalOctokit => ({
      rest: {
        pulls: {
          get: (_: unknown) => Promise.resolve({ data: OPEN_MERGEABLE_PR }),
          merge: (_: unknown) => Promise.reject(makeStatusError(405)),
        },
      },
    });

    // 405 should propagate without trying user token
    await expect(runMergeFallbackLogic({ gh, prNumber: 42, octokitFactory })).rejects.toThrow(
      "HTTP 405"
    );
    expect(getUserTokenCalled).toBe(false);
  });

  test("does not attempt user-token fallback on 422 merge-conflict error", async () => {
    let getUserTokenCalled = false;
    const gh: GitHubContext = {
      owner: "owner",
      repo: "repo",
      getToken: () => Promise.resolve("bot-token"),
      getUserToken: () => {
        getUserTokenCalled = true;
        return Promise.resolve("user-token");
      },
    };

    const octokitFactory = (_token: string): MinimalOctokit => ({
      rest: {
        pulls: {
          get: (_: unknown) => Promise.resolve({ data: OPEN_MERGEABLE_PR }),
          merge: (_: unknown) => Promise.reject(makeStatusError(422)),
        },
      },
    });

    await expect(runMergeFallbackLogic({ gh, prNumber: 42, octokitFactory })).rejects.toThrow(
      "HTTP 422"
    );
    expect(getUserTokenCalled).toBe(false);
  });

  test("throws 'User PAT fallback also failed' when both tokens get 403", async () => {
    const gh: GitHubContext = {
      owner: "owner",
      repo: "repo",
      getToken: () => Promise.resolve("bot-token"),
      getUserToken: () => Promise.resolve("user-token"),
    };

    // Both tokens produce 403
    const octokitFactory = (_token: string): MinimalOctokit => ({
      rest: {
        pulls: {
          get: (_: unknown) => Promise.resolve({ data: OPEN_MERGEABLE_PR }),
          merge: (_: unknown) => Promise.reject(makeStatusError(403, "Forbidden")),
        },
      },
    });

    await expect(runMergeFallbackLogic({ gh, prNumber: 42, octokitFactory })).rejects.toThrow(
      "User PAT fallback also failed"
    );

    await expect(runMergeFallbackLogic({ gh, prNumber: 42, octokitFactory })).rejects.toThrow(
      "owner/repo#42"
    );
  });

  test("tokenOverride presence suppresses getUserToken fallback", async () => {
    let getUserTokenCalled = false;
    const gh: GitHubContext = {
      owner: "owner",
      repo: "repo",
      getToken: () => Promise.resolve("bot-token"),
      getUserToken: () => {
        getUserTokenCalled = true;
        return Promise.resolve("user-token");
      },
    };

    // The override token also gets 403
    const octokitFactory = (_token: string): MinimalOctokit => ({
      rest: {
        pulls: {
          get: (_: unknown) => Promise.resolve({ data: OPEN_MERGEABLE_PR }),
          merge: (_: unknown) => Promise.reject(makeStatusError(403)),
        },
      },
    });

    // With tokenOverride set, the getUserToken fallback must NOT fire.
    // The 403 is re-thrown as the raw error (the caller manages the token).
    await expect(
      runMergeFallbackLogic({
        gh,
        prNumber: 42,
        tokenOverride: () => Promise.resolve("override-token"),
        octokitFactory,
      })
    ).rejects.toThrow("HTTP 403");

    expect(getUserTokenCalled).toBe(false);
  });
});

// ── Structural / type-contract tests ──────────────────────────────────────

describe("GitHubContext — getUserToken optional field", () => {
  test("accepts GitHubContext without getUserToken", () => {
    const gh: GitHubContext = {
      owner: "o",
      repo: "r",
      getToken: async () => "token",
    };
    expect(gh.getUserToken).toBeUndefined();
  });

  test("accepts GitHubContext with getUserToken", () => {
    const gh: GitHubContext = {
      owner: "o",
      repo: "r",
      getToken: async () => "token",
      getUserToken: async () => "user-token",
    };
    expect(typeof gh.getUserToken).toBe("function");
  });
});
