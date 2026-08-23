/**
 * Unit tests for the config.doctor reviewer-retrigger reachability check (mt#2660).
 *
 * checkReviewerRetriggerReachability is exported as a pure function (config
 * token in, diagnostic out) specifically so this behavior is testable without
 * mocking the config-provider module loader (getConfigurationProvider's
 * dynamic import inside config.doctor's execute handler).
 *
 * The second describe block below is production-wiring evidence (reviewer R1,
 * mt#2660): it exercises the REAL `configDoctorRegistration.execute` command
 * object — the same object registered into `sharedCommandRegistry` and
 * invoked by the CLI/MCP `config.doctor` command — against a REAL
 * configuration provider (`initializeConfiguration` + `CustomConfigFactory`,
 * the codebase's public test-configuration seam), rather than only unit
 * testing the pure helper in isolation. Deliberately does NOT use
 * `mock.module` on `@minsky/domain/configuration/index`: see
 * `../observability.test.ts`'s header comment — `mock.module` persists
 * across test files in bun:test with no per-file unmock, so replacing the
 * configuration module would poison other tests that import it later.
 * `initializeConfiguration` reassigns a plain module-level variable instead,
 * which is the same safe, idiomatic seam `packages/domain/src/configuration/index.test.ts`
 * already uses.
 */
import { describe, test, expect } from "bun:test";
import {
  checkReviewerRetriggerReachability,
  checkGithubAppPermissionDrift,
  configDoctorRegistration,
} from "./validate-doctor-commands";
import { CustomConfigFactory, initializeConfiguration } from "@minsky/domain/configuration/index";

const REACHABILITY_CHECK_NAME = "Reviewer Retrigger Reachability";
const GITHUB_APP_PERMISSIONS_CHECK_NAME = "GitHub App Permissions";
const CONFIGURED_MODEL_CHECK_NAME = "Configured Model Validity";
const MCP_AUTH_TOKEN_ENV_VAR = "MINSKY_MCP_AUTH_TOKEN";

/** Minimal valid params for configDoctorRegistration.execute — none of these
 * values are read by the handler's body (only params.json/params.verbose
 * are), so throwaway values satisfy the zod-inferred param type. */
const DOCTOR_EXEC_PARAMS = {
  repo: "",
  workspace: "",
  json: false,
  sources: false,
  verbose: false,
  fix: false,
};

/** Restores (or clears) MINSKY_MCP_AUTH_TOKEN to its pre-test value. */
function restoreMcpAuthToken(saved: string | undefined): void {
  if (saved !== undefined) {
    process.env[MCP_AUTH_TOKEN_ENV_VAR] = saved;
  } else {
    delete process.env[MCP_AUTH_TOKEN_ENV_VAR];
  }
}

describe("checkReviewerRetriggerReachability", () => {
  test("token absent → warning naming mcp.auth.token / MINSKY_MCP_AUTH_TOKEN", () => {
    const result = checkReviewerRetriggerReachability(undefined);

    expect(result.check).toBe(REACHABILITY_CHECK_NAME);
    expect(result.status).toBe("warning");
    expect(result.message).toContain("mcp.auth.token");
    expect(result.suggestion).toContain(MCP_AUTH_TOKEN_ENV_VAR);
  });

  test("token present → pass", () => {
    const result = checkReviewerRetriggerReachability("some-token-value");

    expect(result.check).toBe(REACHABILITY_CHECK_NAME);
    expect(result.status).toBe("pass");
    expect(result.message).toContain("reachable");
  });

  test("empty-string token is treated as absent (falsy) → warning", () => {
    const result = checkReviewerRetriggerReachability("");

    expect(result.status).toBe("warning");
  });
});

describe("checkGithubAppPermissionDrift (mt#3218)", () => {
  test("no App configured → pass, nothing to check", async () => {
    const result = await checkGithubAppPermissionDrift(undefined);

    expect(result.check).toBe(GITHUB_APP_PERMISSIONS_CHECK_NAME);
    expect(result.status).toBe("pass");
    expect(result.message).toContain("No GitHub App service account configured");
  });

  /**
   * The permission set the live `minsky-ai` App holds, read from `GET /app` on
   * 2026-08-19 (mt#3264). Using the real set keeps a "pass" case honest: before
   * mt#3264, `workflows`/`actions` were absent from REQUIRED_APP_PERMISSIONS, so
   * this check passed on an App that could not push a workflow file at all.
   */
  const LIVE_APP_PERMISSIONS: Record<string, string> = {
    actions: "write",
    contents: "write",
    metadata: "read",
    pull_requests: "write",
    workflows: "write",
  };

  test("all required permissions present → pass", async () => {
    const result = await checkGithubAppPermissionDrift({
      slug: "minsky-ai",
      permissions: { ...LIVE_APP_PERMISSIONS },
    });

    expect(result.status).toBe("pass");
    expect(result.message).toContain("minsky-ai");
  });

  test("workflows absent → warning naming the settings URL (mt#3264 case)", async () => {
    const withoutWorkflows = { ...LIVE_APP_PERMISSIONS };
    delete withoutWorkflows.workflows;

    const result = await checkGithubAppPermissionDrift({
      slug: "minsky-ai",
      permissions: withoutWorkflows,
    });

    expect(result.status).toBe("warning");
    expect(result.message).toContain("workflows");
    expect(result.suggestion).toContain("https://github.com/settings/apps/minsky-ai/permissions");
  });

  test("contents:read instead of contents:write → warning naming the settings URL (mt#3210 case)", async () => {
    const result = await checkGithubAppPermissionDrift({
      slug: "minsky-ai",
      permissions: { ...LIVE_APP_PERMISSIONS, contents: "read" },
    });

    expect(result.status).toBe("warning");
    expect(result.message).toContain("https://github.com/settings/apps/minsky-ai/permissions");
    expect(result.message).toContain("contents");
    expect(result.suggestion).toContain("https://github.com/settings/apps/minsky-ai/permissions");
    expect(result.suggestion).toMatch(/accept/i);
  });
});

describe("config.doctor execute — reviewer retrigger reachability (production wiring, mt#2660 reviewer R1)", () => {
  /**
   * Hermeticity (mt#2679): the real configuration provider merges the
   * OPERATOR's user config (~/.config/minsky/config.yaml) underneath the test
   * overrides, and `mcp: { auth: {} }` does not null out a token merged from
   * below. On a machine where the operator HAS set mcp.auth.token (the
   * mt#2679 fix makes that the expected steady state), the token-absent test
   * would read the real token and fail. Redirect XDG_CONFIG_HOME to an empty
   * temp dir for the duration of each test so the user source loads nothing.
   */
  const XDG_ENV_VAR = "XDG_CONFIG_HOME";

  async function withIsolatedUserConfig<T>(fn: () => Promise<T>): Promise<T> {
    const savedToken = process.env[MCP_AUTH_TOKEN_ENV_VAR];
    const savedXdg = process.env[XDG_ENV_VAR];
    delete process.env[MCP_AUTH_TOKEN_ENV_VAR];
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    // A NONEXISTENT dir suffices — the user source existsSync-checks each
    // candidate config file and loads nothing. No real fs writes needed.
    process.env[XDG_ENV_VAR] = join(
      tmpdir(),
      `minsky-doctor-test-isolated-${process.pid}-${Math.random().toString(36).slice(2)}`
    );
    try {
      return await fn();
    } finally {
      restoreMcpAuthToken(savedToken);
      if (savedXdg !== undefined) {
        process.env[XDG_ENV_VAR] = savedXdg;
      } else {
        delete process.env[XDG_ENV_VAR];
      }
    }
  }

  test("reviewer service configured, mcp.auth.token absent → doctor diagnostics include the warning", async () => {
    await withIsolatedUserConfig(async () => {
      // Real configuration provider (not a module mock) with the reviewer
      // service explicitly configured (reviewer.url set) and mcp.auth.token
      // deliberately absent — the exact scenario named in the finding.
      await initializeConfiguration(new CustomConfigFactory(), {
        overrides: {
          reviewer: { url: "https://example-reviewer.example.com" },
          mcp: { auth: {} },
        },
        skipValidation: true,
      });

      const result = (await configDoctorRegistration.execute(DOCTOR_EXEC_PARAMS, {})) as {
        diagnostics: Array<{ check: string; status: string; message: string }>;
      };

      const diag = result.diagnostics.find((d) => d.check === REACHABILITY_CHECK_NAME);
      expect(diag).toBeDefined();
      expect(diag?.status).toBe("warning");
      expect(diag?.message).toContain("mcp.auth.token");
    });
  });

  test("mcp.auth.token present → doctor diagnostics report reachable (pass)", async () => {
    await withIsolatedUserConfig(async () => {
      await initializeConfiguration(new CustomConfigFactory(), {
        overrides: {
          reviewer: { url: "https://example-reviewer.example.com" },
          mcp: { auth: { token: "real-token-value" } },
        },
        skipValidation: true,
      });

      const result = (await configDoctorRegistration.execute(DOCTOR_EXEC_PARAMS, {})) as {
        diagnostics: Array<{ check: string; status: string; message: string }>;
      };

      const diag = result.diagnostics.find((d) => d.check === REACHABILITY_CHECK_NAME);
      expect(diag).toBeDefined();
      expect(diag?.status).toBe("pass");
    });
  });

  test("no github.serviceAccount configured → GitHub App Permissions diagnostic is pass (mt#3218)", async () => {
    await withIsolatedUserConfig(async () => {
      await initializeConfiguration(new CustomConfigFactory(), {
        overrides: {
          reviewer: { url: "https://example-reviewer.example.com" },
          mcp: { auth: { token: "real-token-value" } },
        },
        skipValidation: true,
      });

      const result = (await configDoctorRegistration.execute(DOCTOR_EXEC_PARAMS, {})) as {
        diagnostics: Array<{ check: string; status: string; message: string }>;
      };

      const diag = result.diagnostics.find((d) => d.check === GITHUB_APP_PERMISSIONS_CHECK_NAME);
      expect(diag).toBeDefined();
      expect(diag?.status).toBe("pass");
    });
  });

  /**
   * Production wiring for the configured-model check (mt#3389, reviewer R1).
   * The pure functions are covered in `doctor-model-checks.test.ts`; this
   * proves the REAL registered command actually reaches them and emits the
   * diagnostic — without it the check would be dead code that no unit test
   * could distinguish from wired code.
   *
   * Deliberately asserts only that the diagnostic is PRESENT and well-formed,
   * not its status: the handler reads the machine's real model cache
   * (~/.cache/minsky/models), which is populated on a developer box and empty
   * on CI. Asserting "warning" here would pass locally and fail in CI for a
   * reason unrelated to the code — the status-dependent behavior belongs to
   * the pure-function tests, which control the listing directly.
   */
  test("configured-model check is reached by the real command and emits a diagnostic", async () => {
    await withIsolatedUserConfig(async () => {
      await initializeConfiguration(new CustomConfigFactory(), {
        overrides: {
          ai: { providers: { anthropic: { model: "definitely-not-a-real-model-id" } } },
        },
        skipValidation: true,
      });

      const result = (await configDoctorRegistration.execute(DOCTOR_EXEC_PARAMS, {})) as {
        diagnostics: Array<{ check: string; status: string; message: string }>;
      };

      const diag = result.diagnostics.find((d) => d.check === CONFIGURED_MODEL_CHECK_NAME);
      expect(diag).toBeDefined();
      expect(typeof diag?.message).toBe("string");
      expect(diag?.message.length).toBeGreaterThan(0);
      // Never the opaque catch-all — that would mean the block threw.
      expect(diag?.message).not.toContain("Configured model check failed");
    });
  });
});
