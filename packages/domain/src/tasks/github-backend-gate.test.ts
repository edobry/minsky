/**
 * Tests for the tasks.githubBackend.enabled config gate (mt#2579).
 *
 * Acceptance criteria:
 * - flag false (default): createConfiguredTaskService with no `backend` registers ONLY the
 *   minsky backend (assert github NOT registered); explicit backend:"github" throws an error
 *   whose message names the enable flag.
 * - flag true: github backend registration is attempted when GitHub config is present
 *   (back-compat); getting past the disabled gate is demonstrated by reaching the credentials
 *   error instead of the disabled error.
 * - tasks_create with no backend arg still routes to mt# (unchanged behavior).
 *
 * NOTE: Config is initialized per-test (not in beforeAll) to ensure each test has
 * deterministic global config state regardless of Bun's beforeAll execution order.
 */

import { describe, test, expect } from "bun:test";
import { createConfiguredTaskService } from "./taskService";
import { FakePersistenceProvider } from "../persistence/fake-persistence-provider";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Non-existent workspace path — ensures no real git/config is found. */
function fakeWs(): string {
  return "/mock/nonexistent/github-backend-gate-test";
}

/**
 * Initialize the global config with the given overrides.
 * Called at the start of each test to ensure deterministic config state.
 */
async function initConfig(overrides: Record<string, unknown>): Promise<void> {
  const { initializeConfiguration, CustomConfigFactory } = await import("../configuration/index");
  await initializeConfiguration(new CustomConfigFactory(), {
    overrides,
    enableCache: false,
    skipValidation: true,
  });
}

/** Convenience: initialize config with github backend disabled (default). */
async function withGithubDisabled(): Promise<void> {
  return initConfig({ tasks: { githubBackend: { enabled: false } } });
}

/** Convenience: initialize config with github backend enabled. */
async function withGithubEnabled(): Promise<void> {
  return initConfig({ tasks: { githubBackend: { enabled: true } } });
}

// ---------------------------------------------------------------------------
// Flag = false (default) — github backend disabled
// ---------------------------------------------------------------------------

describe("GitHub-issues backend gate: flag=false (default)", () => {
  test("multi-backend mode: github backend NOT in registered backends", async () => {
    await withGithubDisabled();

    const service = await createConfiguredTaskService({
      workspacePath: fakeWs(),
      persistenceProvider: new FakePersistenceProvider(),
      // No `backend` → multi-backend mode
    });

    const backends = service.listBackends?.() ?? [];
    const hasGithub = backends.some((b) => b.prefix === "gh" || b.name === "github");
    expect(hasGithub).toBe(false);
  });

  test("explicit backend:'github' throws an error naming tasks.githubBackend.enabled=true", async () => {
    await withGithubDisabled();

    const err = await createConfiguredTaskService({
      workspacePath: fakeWs(),
      backend: "github",
      persistenceProvider: new FakePersistenceProvider(),
    }).catch((e) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("tasks.githubBackend.enabled=true");
  });

  test("explicit backend:'github' error message says 'disabled' (no silent fallback)", async () => {
    await withGithubDisabled();

    const err = await createConfiguredTaskService({
      workspacePath: fakeWs(),
      backend: "github",
      persistenceProvider: new FakePersistenceProvider(),
    }).catch((e) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/disabled/i);
  });

  test("service is created successfully in multi-backend mode (no throw)", async () => {
    await withGithubDisabled();

    const service = await createConfiguredTaskService({
      workspacePath: fakeWs(),
      persistenceProvider: new FakePersistenceProvider(),
    });
    expect(service).toBeDefined();
    expect(typeof service.listTasks).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Flag = true — github backend enabled (back-compat path)
// ---------------------------------------------------------------------------

describe("GitHub-issues backend gate: flag=true (backend enabled)", () => {
  test("explicit backend:'github' with flag=true gets past the disabled gate", async () => {
    await withGithubEnabled();

    // With flag=true but no actual GitHub credentials (fake workspace), the error
    // should be about missing credentials — NOT about the backend being disabled.
    const err = await createConfiguredTaskService({
      workspacePath: fakeWs(),
      backend: "github",
      persistenceProvider: new FakePersistenceProvider(),
    }).catch((e) => e as Error);

    expect(err).toBeInstanceOf(Error);
    // Must NOT be the "disabled" error; the gate was passed.
    expect(err.message).not.toMatch(/disabled/i);
    expect(err.message).not.toContain("tasks.githubBackend.enabled=true");
    // Should be the credentials / config-not-available error.
    expect(err.message).toMatch(/GitHub backend configuration not available/i);
  });
});
