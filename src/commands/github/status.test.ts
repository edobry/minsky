/**
 * Tests for `showGitHubStatus` (mt#4679).
 *
 * Covers two defects:
 *
 * 1. `get("backend")` queried the deprecated top-level `backend` alias for
 *    `tasks.backend` (`packages/domain/src/configuration/schemas/backend.ts`:
 *    `@deprecated Use tasks.backend instead`). Most project configs set
 *    `tasks.backend` directly and never set the deprecated alias, so the lookup threw
 *    `Configuration path 'backend' not found` for the common case. The unguarded
 *    second call to this same path in the Summary section then propagated that
 *    exception all the way to the CLI's generic `main().catch()` handler.
 * 2. Even a genuinely unexpected config-loading failure should produce a clean,
 *    handled message and a non-zero exit — never the generic
 *    "Unhandled error in CLI: ..." wrapper.
 *
 * Hermetic — injects fakes via `ShowGitHubStatusDeps` (the DI seam this task added).
 * `mock.module()` is banned repo-wide by `custom/no-global-module-mocks`.
 */
import { describe, test, expect } from "bun:test";
import { showGitHubStatus, type ShowGitHubStatusDeps } from "./status";
import type { getConfiguration } from "@minsky/domain/configuration";
import type { getGitHubBackendConfig } from "@minsky/domain/tasks/githubBackendConfig";

const FAKE_CONFIG_WITH_TOKEN = {
  github: { token: "fake-token" },
} as unknown as ReturnType<typeof getConfiguration>;

const FAKE_REPO_CONFIG = {
  owner: "edobry",
  repo: "minsky",
  githubToken: "fake-token",
} as unknown as ReturnType<typeof getGitHubBackendConfig>;

/**
 * A minimal in-memory config store mirroring `ConfigurationProvider.get`/`.has`
 * semantics: `get(path)` throws `Configuration path '<path>' not found` when the
 * resolved value is `undefined`; `has(path)` never throws.
 */
function makeConfigStore(data: Record<string, unknown>): Pick<ShowGitHubStatusDeps, "get" | "has"> {
  function resolve(path: string): unknown {
    return path.split(".").reduce<unknown>((acc, segment) => {
      if (acc && typeof acc === "object") {
        return (acc as Record<string, unknown>)[segment];
      }
      return undefined;
    }, data);
  }

  return {
    get: (<T>(path: string) => {
      const value = resolve(path);
      if (value === undefined) {
        throw new Error(`Configuration path '${path}' not found`);
      }
      return value as T;
    }) as ShowGitHubStatusDeps["get"],
    has: (path: string) => resolve(path) !== undefined,
  };
}

describe("showGitHubStatus", () => {
  test(
    "config lacking the queried key ('tasks.backend' absent): handled failure, " +
      "no raw 'Configuration path' exception escapes the function",
    async () => {
      const store = makeConfigStore({}); // no tasks.backend, no backendConfig, no github

      const result = await showGitHubStatus(
        {},
        {
          getConfiguration: () => FAKE_CONFIG_WITH_TOKEN,
          getGitHubBackendConfig: () => FAKE_REPO_CONFIG,
          ...store,
        }
      );

      // The function must not throw (asserted implicitly: no `await expect(...).rejects`
      // needed — an unhandled throw here would fail the test directly) and must signal
      // failure via its return value so the caller can set a non-zero exit code.
      expect(result).toBe(false);
    }
  );

  test("happy path: all checks pass, returns true", async () => {
    const store = makeConfigStore({
      tasks: { backend: "github-issues" },
      backendConfig: {},
      github: { organization: "edobry", repository: "minsky" },
    });

    const result = await showGitHubStatus(
      {},
      {
        getConfiguration: () => FAKE_CONFIG_WITH_TOKEN,
        getGitHubBackendConfig: () => FAKE_REPO_CONFIG,
        ...store,
      }
    );

    expect(result).toBe(true);
  });

  test("task backend not github-issues, but no exception: informational, still returns true", async () => {
    // `github` must be present (as `{}`) to match production reality: the top-level
    // `github` config schema key always resolves via defaults (mirroring `tasks.backend`),
    // it is never genuinely "not found" — only this test's earlier fixture omitted it.
    const store = makeConfigStore({
      tasks: { backend: "minsky" },
      backendConfig: {},
      github: {},
    });

    const result = await showGitHubStatus(
      {},
      {
        getConfiguration: () => FAKE_CONFIG_WITH_TOKEN,
        getGitHubBackendConfig: () => FAKE_REPO_CONFIG,
        ...store,
      }
    );

    expect(result).toBe(true);
  });

  test("no GitHub repository detected: informational, still returns true", async () => {
    const store = makeConfigStore({
      tasks: { backend: "minsky" },
      backendConfig: {},
      github: {},
    });

    const result = await showGitHubStatus(
      {},
      {
        getConfiguration: () => FAKE_CONFIG_WITH_TOKEN,
        getGitHubBackendConfig: () => null,
        ...store,
      }
    );

    expect(result).toBe(true);
  });

  test("repository detection throws unexpectedly: handled failure, returns false", async () => {
    const store = makeConfigStore({
      tasks: { backend: "minsky" },
      backendConfig: {},
    });

    const result = await showGitHubStatus(
      {},
      {
        getConfiguration: () => FAKE_CONFIG_WITH_TOKEN,
        getGitHubBackendConfig: () => {
          throw new Error("git remote lookup failed");
        },
        ...store,
      }
    );

    expect(result).toBe(false);
  });
});
