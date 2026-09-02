/**
 * Tests for `testGitHubConnection` (mt#4679).
 *
 * Covers the false-green defect: a repository-access failure (e.g. a 404 from
 * `octokit.rest.repos.get`) used to be silently absorbed by the same try/catch that
 * exists to tolerate "not in a GitHub repository" (a benign, non-error state), letting
 * execution fall through to the success banner. The function now tracks failures
 * explicitly and returns `false` (rather than printing the banner) when any check
 * failed, so the CLI entrypoint (`src/commands/github/index.ts`) can translate that
 * into a non-zero exit code.
 *
 * Hermetic — injects fakes via `TestGitHubConnectionDeps` (the DI seam this task added).
 * `mock.module()` on `@octokit/rest` is not an option (banned repo-wide by
 * `custom/no-global-module-mocks`), so dependency injection is the sanctioned mechanism.
 */
import { describe, test, expect } from "bun:test";
import { testGitHubConnection, type OctokitLike } from "./test";
import type { getConfiguration } from "@minsky/domain/configuration/index";
import type { getGitHubBackendConfig } from "@minsky/domain/tasks/githubBackendConfig";

const FAKE_CONFIG_WITH_TOKEN = {
  github: { token: "fake-token" },
} as unknown as ReturnType<typeof getConfiguration>;

const FAKE_REPO_CONFIG = {
  owner: "edobry",
  repo: "minsky",
} as unknown as ReturnType<typeof getGitHubBackendConfig>;

function makeOctokit(overrides: Partial<OctokitLike["rest"]> = {}): OctokitLike {
  return {
    rest: {
      users: {
        getAuthenticated: async () => ({ data: { login: "edobry" } }),
      },
      repos: {
        get: async () => ({
          data: { full_name: "edobry/minsky", private: false, permissions: { push: true } },
        }),
      },
      rateLimit: {
        get: async () => ({
          data: { resources: { core: { remaining: 5000, limit: 5000, reset: 0 } } },
        }),
      },
      ...overrides,
    },
  };
}

describe("testGitHubConnection", () => {
  test("repository-access failure: returns false (was: silently swallowed, returned success)", async () => {
    const notFoundError = Object.assign(new Error("Not Found"), { status: 404 });
    const octokit = makeOctokit({
      repos: {
        get: async () => {
          throw notFoundError;
        },
      },
    });

    const result = await testGitHubConnection(
      {},
      {
        getConfiguration: () => FAKE_CONFIG_WITH_TOKEN,
        getGitHubBackendConfig: () => FAKE_REPO_CONFIG,
        octokit,
      }
    );

    expect(result).toBe(false);
  });

  test("happy path: all checks pass, returns true", async () => {
    const octokit = makeOctokit();

    const result = await testGitHubConnection(
      {},
      {
        getConfiguration: () => FAKE_CONFIG_WITH_TOKEN,
        getGitHubBackendConfig: () => FAKE_REPO_CONFIG,
        octokit,
      }
    );

    expect(result).toBe(true);
  });

  test("no repo detected in current directory: benign, still returns true", async () => {
    const octokit = makeOctokit();

    const result = await testGitHubConnection(
      {},
      {
        getConfiguration: () => FAKE_CONFIG_WITH_TOKEN,
        getGitHubBackendConfig: () => null,
        octokit,
      }
    );

    expect(result).toBe(true);
  });

  test("no GitHub token configured: still throws (pre-existing, unchanged behavior)", async () => {
    const octokit = makeOctokit();

    await expect(
      testGitHubConnection(
        {},
        {
          getConfiguration: () =>
            ({ github: { token: undefined } }) as unknown as ReturnType<typeof getConfiguration>,
          getGitHubBackendConfig: () => FAKE_REPO_CONFIG,
          octokit,
        }
      )
    ).rejects.toThrow("GitHub token not configured");
  });

  test("rate-limit API failure: still throws (pre-existing, unchanged behavior)", async () => {
    const rateLimitError = Object.assign(new Error("Service Unavailable"), { status: 503 });
    const octokit = makeOctokit({
      rateLimit: {
        get: async () => {
          throw rateLimitError;
        },
      },
    });

    await expect(
      testGitHubConnection(
        {},
        {
          getConfiguration: () => FAKE_CONFIG_WITH_TOKEN,
          getGitHubBackendConfig: () => FAKE_REPO_CONFIG,
          octokit,
        }
      )
    ).rejects.toBe(rateLimitError);
  });
});
