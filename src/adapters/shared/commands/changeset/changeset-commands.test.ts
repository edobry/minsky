/**
 * Tests for changeset-commands.ts repo-param resolution (mt#2745).
 *
 * Before mt#2745, all four changeset handlers (`list` / `search` / `get` /
 * `info`) declared `repo: CommonParameters.repo` but called
 * `getRepositoryBackendFromConfig()` unconditionally — `params.repo` was never
 * read, so callers naming a repo were silently routed to the ambient one.
 * The fix routes resolution through `resolveChangesetRepoUrl`, which honors
 * an explicit repo via `resolveRepositoryAndBackend({ repoParam })` (the same
 * `--repo` semantic as the rest of the CLI) and falls back to ambient config
 * resolution otherwise.
 *
 * Tests use the domain module's own `RepositoryBackendDetectionDeps` injection
 * seam (execSync / getConfiguration) — no module mocks needed.
 */

import { describe, test, expect } from "bun:test";
import { resolveChangesetRepoUrl } from "./changeset-commands";
import type { RepositoryBackendDetectionDeps } from "@minsky/domain/session/repository-backend-detection";

const OTHER_REPO = "https://github.com/other-org/other-repo.git";
const AMBIENT_REPO = "https://github.com/ambient-org/ambient-repo.git";

/**
 * Deps whose every member throws — proving a branch was NOT consulted.
 * The repoParam short-circuit must return before any config read or git probe.
 */
const throwingDeps: RepositoryBackendDetectionDeps = {
  execSync: () => {
    throw new Error("execSync must not be called on the repoParam short-circuit");
  },
  getConfiguration: () => {
    throw new Error("getConfiguration must not be called on the repoParam short-circuit");
  },
};

/** Deps that resolve the ambient repo from injected config (no git probes). */
const ambientDeps: RepositoryBackendDetectionDeps = {
  execSync: () => {
    throw new Error("execSync must not be called when config resolves the backend");
  },
  getConfiguration: () => ({
    repository: {
      backend: "github",
      url: AMBIENT_REPO,
      github: { owner: "ambient-org", repo: "ambient-repo" },
    },
  }),
};

describe("resolveChangesetRepoUrl (mt#2745)", () => {
  test("honors an explicit repo param — returns the named repo, not the ambient one", async () => {
    const repoUrl = await resolveChangesetRepoUrl(OTHER_REPO, throwingDeps);
    expect(repoUrl).toBe(OTHER_REPO);
  });

  test("repoParam short-circuit consults neither config nor git probes", async () => {
    // throwingDeps would reject the promise if either seam were touched.
    await expect(resolveChangesetRepoUrl(OTHER_REPO, throwingDeps)).resolves.toBe(OTHER_REPO);
  });

  test("ambient path (repo absent) resolves from configuration, unchanged", async () => {
    const repoUrl = await resolveChangesetRepoUrl(undefined, ambientDeps);
    expect(repoUrl).toBe(AMBIENT_REPO);
  });

  test("explicit repo wins over ambient config when both are available", async () => {
    const repoUrl = await resolveChangesetRepoUrl(OTHER_REPO, ambientDeps);
    expect(repoUrl).toBe(OTHER_REPO);
  });
});

describe("changeset handlers are bound to the repo-aware resolver (mt#2745)", () => {
  test("all four registered changeset commands declare repo AND route through resolveChangesetRepoUrl", async () => {
    // Register into the global shared registry (test cleanup resets it), then
    // assert each command (a) declares the `repo` param and (b) its execute
    // source routes through the shared resolver. The toString() containment
    // check is a deliberate lightweight structural binding — the resolver's
    // behavior is unit-tested above; this guards against a handler regressing
    // to the old unconditional getRepositoryBackendFromConfig() call.
    const { registerChangesetCommands } = await import("./changeset-commands");
    const { sharedCommandRegistry } = await import("../../command-registry");

    if (!sharedCommandRegistry.hasCommand("changeset.list")) {
      registerChangesetCommands();
    }

    for (const id of ["changeset.list", "changeset.search", "changeset.get", "changeset.info"]) {
      const cmd = sharedCommandRegistry.getCommand(id);
      expect(cmd).toBeDefined();
      expect(cmd?.parameters?.repo).toBeDefined();
      expect(cmd?.execute.toString()).toContain("resolveChangesetRepoUrl");
    }
  });
});
