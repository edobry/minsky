/**
 * Tests for `showGitHubStatus` (mt#4679, R1 fixes from PR #3422 review round 1).
 *
 * Covers three defects:
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
 * 3. R1 — the MIRROR of defect 1: the initial fix for (1) left `backendConfig` and
 *    `github` reads unguarded. An entirely unconfigured project (no `tasks.backend`, no
 *    `backendConfig`, no `github` block — an ordinary, common, INFORMATIONAL state, not
 *    a failure) threw on the `backendConfig` lookup inside Step 2's try, and that catch
 *    set `hadFailure = true` — turning a correct "needs setup" ⚠️ summary (which should
 *    exit 0) into a false non-zero exit. Same defect class as the bug this task fixes,
 *    sign flipped: a false FAILURE instead of a false SUCCESS. Fixed by guarding
 *    `backendConfig` and `github` reads with `has()`, exactly like `tasks.backend`.
 * 4. R2 — the R1 fix guarded one call site and missed a second: Step 5's Summary
 *    section called `getGitHubBackendConfig(process.cwd())` again — the EXACT same
 *    call Step 3 already made and stored in `repoConfig` (`process.cwd()` ===
 *    Step 3's `workdir`) — unguarded by any try/catch, sitting in the outer try only.
 *    Fixed by reusing `repoConfig` instead of recomputing it — this is not just DRY,
 *    it removes the second unguarded exposure entirely rather than adding a third
 *    try/catch. Full sweep of every getter call site in this file and test.ts
 *    performed for this round; see PR #3422 body for the enumerated list.
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
    "R1: fully unconfigured project (no tasks.backend, no backendConfig, no github " +
      "block): this is INFORMATIONAL — nothing is broken, it just needs setup — so it " +
      "must NOT be misclassified as a failure",
    async () => {
      const store = makeConfigStore({}); // nothing configured anywhere — the common case

      const result = await showGitHubStatus(
        {},
        {
          getConfiguration: () => FAKE_CONFIG_WITH_TOKEN,
          getGitHubBackendConfig: () => FAKE_REPO_CONFIG,
          ...store,
        }
      );

      // The function must not throw (asserted implicitly — an unhandled throw here
      // would fail the test directly) AND must report success, because nothing
      // actually FAILED: task backend isn't github-issues, that's it. mt#4679's whole
      // point is that the exit code tells the truth in both directions.
      expect(result).toBe(true);
    }
  );

  test(
    "genuinely broken configuration provider (has()/get() themselves throw, not just " +
      "an absent optional key): handled failure, no raw exception escapes the function",
    async () => {
      const brokenStore: Pick<ShowGitHubStatusDeps, "get" | "has"> = {
        has: () => {
          throw new Error("configuration provider unavailable");
        },
        get: (() => {
          throw new Error("configuration provider unavailable");
        }) as ShowGitHubStatusDeps["get"],
      };

      const result = await showGitHubStatus(
        {},
        {
          getConfiguration: () => FAKE_CONFIG_WITH_TOKEN,
          getGitHubBackendConfig: () => FAKE_REPO_CONFIG,
          ...brokenStore,
        }
      );

      // Distinguishes "config system is actually broken" (a real failure) from "a key
      // is merely absent" (informational, the case above) — only the former sets
      // hadFailure. The function must not throw (asserted implicitly) and must signal
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

  test(
    "R2: getGitHubBackendConfig is called exactly once per run, not twice — Step 5's " +
      "Summary reuses Step 3's repoConfig instead of recomputing it (redundant AND " +
      "unguarded in the R1 code)",
    async () => {
      const store = makeConfigStore({
        tasks: { backend: "minsky" },
        backendConfig: {},
        github: {},
      });
      let callCount = 0;

      const result = await showGitHubStatus(
        {},
        {
          getConfiguration: () => FAKE_CONFIG_WITH_TOKEN,
          getGitHubBackendConfig: () => {
            callCount += 1;
            return FAKE_REPO_CONFIG;
          },
          ...store,
        }
      );

      expect(result).toBe(true);
      // Under the R1 code this was 2 (Step 3's detection call, plus Step 5's
      // unguarded re-fetch for `hasRepo`). A getter that throws on the SECOND call
      // but not the first would have passed every other test in this file while
      // still carrying the R2 defect — call-count is the only assertion that
      // actually pins the call site down to one.
      expect(callCount).toBe(1);
    }
  );
});
