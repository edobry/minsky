/**
 * Tests for the github-issues backend disabled gate in createConfiguredTaskService.
 *
 * Acceptance criteria (mt#2579 R1 review item 1):
 * - Any of the 4 backend identifiers ("github", "github-issues", "GITHUB", "GITHUB_ISSUES")
 *   throws the clear "disabled" error when tasks.githubBackend.enabled is false (default).
 */

import { describe, test, expect } from "bun:test";
import { createConfiguredTaskService } from "./taskService";
import { TaskBackend } from "../configuration/backend-types";
import { FakePersistenceProvider } from "../persistence/fake-persistence-provider";

const DISABLED_ERROR_FRAGMENT =
  "GitHub-issues task backend is disabled. Set tasks.githubBackend.enabled=true in your Minsky config to use it.";

describe("github-issues backend disabled gate", () => {
  // When the config flag is absent / false (the default), every github backend
  // identifier must throw the clear disabled error — not "Unknown backend".

  test('backend:"github" (TaskBackend.GITHUB) throws disabled error', async () => {
    await expect(
      createConfiguredTaskService({
        workspacePath: "/test/workspace",
        backend: TaskBackend.GITHUB, // "github"
        persistenceProvider: new FakePersistenceProvider(),
      })
    ).rejects.toThrow(DISABLED_ERROR_FRAGMENT);
  });

  test('backend:"github-issues" (TaskBackend.GITHUB_ISSUES) throws disabled error', async () => {
    // This is the identifier the R1 reviewer found was NOT gated — it fell through
    // to the "Unknown backend" default instead of the clear disabled error.
    await expect(
      createConfiguredTaskService({
        workspacePath: "/test/workspace",
        backend: TaskBackend.GITHUB_ISSUES, // "github-issues"
        persistenceProvider: new FakePersistenceProvider(),
      })
    ).rejects.toThrow(DISABLED_ERROR_FRAGMENT);
  });

  test('backend:"GITHUB" (enum member name, uppercase) throws disabled error', async () => {
    await expect(
      createConfiguredTaskService({
        workspacePath: "/test/workspace",
        backend: "GITHUB",
        persistenceProvider: new FakePersistenceProvider(),
      })
    ).rejects.toThrow(DISABLED_ERROR_FRAGMENT);
  });

  test('backend:"GITHUB_ISSUES" (enum member name, uppercase) throws disabled error', async () => {
    await expect(
      createConfiguredTaskService({
        workspacePath: "/test/workspace",
        backend: "GITHUB_ISSUES",
        persistenceProvider: new FakePersistenceProvider(),
      })
    ).rejects.toThrow(DISABLED_ERROR_FRAGMENT);
  });

  test('backend:"minsky" does NOT throw disabled error', async () => {
    // Minsky backend goes through a different path; ensure the helper doesn't
    // accidentally capture it. It may throw for other reasons (no DB) but not disabled.
    await expect(
      createConfiguredTaskService({
        workspacePath: "/test/workspace",
        backend: TaskBackend.MINSKY, // "minsky"
        persistenceProvider: new FakePersistenceProvider(),
      })
    ).rejects.not.toThrow(DISABLED_ERROR_FRAGMENT);
  });
});
