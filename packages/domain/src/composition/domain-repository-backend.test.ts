/**
 * Tests for boot-deferrable repository-backend resolution (mt#2460).
 *
 * The `repositoryBackend` factory's detection is environment-dependent: with
 * no `repository.backend` config it shells out to `git remote get-url origin`,
 * which cannot succeed in a deployed headless container (no git binary, no
 * .git in the COPY'd /app tree). Detection failure must defer to use-time —
 * not abort container.initialize() — so entry points that never touch the
 * repository backend (e.g. the reviewer service) still boot.
 */

import { describe, test, expect } from "bun:test";
import { TsyringeContainer } from "./container";
import { resolveRepositoryBackendForBoot } from "./domain";
import { RepositoryBackendType } from "../repository/index";
import type { AppServices } from "./types";

const REPOSITORY_BACKEND_KEY = "repositoryBackend";

type RepositoryBackendConfig = AppServices[typeof REPOSITORY_BACKEND_KEY];

const detected: RepositoryBackendConfig = {
  repoUrl: "https://github.com/edobry/minsky.git",
  backendType: RepositoryBackendType.GITHUB,
  github: { owner: "edobry", repo: "minsky" },
};

describe("resolveRepositoryBackendForBoot (mt#2460)", () => {
  test("successful detection passes the result through unchanged", async () => {
    const result = await resolveRepositoryBackendForBoot(async () => detected);
    expect(result).toEqual(detected);
  });

  test("detection failure throws a bootDeferrable-marked error naming the cause", async () => {
    const failing = async (): Promise<RepositoryBackendConfig> => {
      throw new Error(
        "Default repository backend is GitHub, but could not detect GitHub remote: git: not found"
      );
    };

    let thrown: (Error & { bootDeferrable?: boolean }) | undefined;
    try {
      await resolveRepositoryBackendForBoot(failing);
    } catch (err) {
      thrown = err as Error & { bootDeferrable?: boolean };
    }

    expect(thrown).toBeDefined();
    expect(thrown?.bootDeferrable).toBe(true);
    expect(thrown?.message).toContain("Repository backend unavailable");
    expect(thrown?.message).toContain("git: not found");
  });

  test("detection failure defers: initialize() completes, sibling services resolve, touching repositoryBackend throws", async () => {
    const c = new TsyringeContainer();
    c.register(
      REPOSITORY_BACKEND_KEY as never,
      () =>
        resolveRepositoryBackendForBoot(async () => {
          throw new Error("/bin/sh: 1: git: not found");
        }) as never
    );
    c.register("taskService" as never, () => ({ healthy: true }) as never);

    // The git-less-environment failure must NOT abort boot.
    await c.initialize();

    // Sibling services resolve normally.
    expect((c.get("taskService" as never) as { healthy: boolean }).healthy).toBe(true);

    // The deferred placeholder throws the clear error only when actually used.
    const rb = c.get(REPOSITORY_BACKEND_KEY as never) as Record<string, () => unknown>;
    expect(() => rb.repoUrl()).toThrow(/unavailable/);
    expect(() => rb.repoUrl()).toThrow(/git: not found/);
  });
});
