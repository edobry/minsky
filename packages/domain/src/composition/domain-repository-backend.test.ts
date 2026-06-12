/**
 * Tests for boot-tolerant repository-backend resolution (mt#2460).
 *
 * The `repositoryBackend` factory's detection is environment-dependent: with
 * no `repository.backend` config it shells out to `git remote get-url origin`,
 * which cannot succeed in a deployed headless container (no git binary, no
 * .git in the COPY'd /app tree). Detection failure must defer to use-time —
 * not abort container.initialize() — so entry points that never touch the
 * repository backend (e.g. the reviewer service) still boot.
 *
 * Because `repositoryBackend` is a plain VALUE OBJECT (not a method-bearing
 * service), the deferred placeholder throws on data-field READS — the generic
 * container placeholder's call-to-throw contract would let `placeholder.repoUrl`
 * silently yield a function instead of a string (PR #1677 R1 finding).
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

const failingDetect = async (): Promise<RepositoryBackendConfig> => {
  throw new Error(
    "Default repository backend is GitHub, but could not detect GitHub remote: git: not found"
  );
};

describe("resolveRepositoryBackendForBoot (mt#2460)", () => {
  test("successful detection passes the result through unchanged", async () => {
    const result = await resolveRepositoryBackendForBoot(async () => detected);
    expect(result).toEqual(detected);
  });

  test("detection failure returns a placeholder instead of throwing — boot survives", async () => {
    // Must NOT throw: the await itself exercises the placeholder's `then`
    // benignity (a throwing `then` read would crash the await).
    const placeholder = await resolveRepositoryBackendForBoot(failingDetect);
    expect(placeholder).toBeDefined();
  });

  test("placeholder data-field READS throw the clear deferred error naming the cause", async () => {
    const placeholder = await resolveRepositoryBackendForBoot(failingDetect);

    // Consumers read fields directly (e.g. start-session-operations.ts reads
    // `.repoUrl` / `.backendType`) — a read must throw, not yield a function.
    expect(() => placeholder.repoUrl).toThrow(/unavailable/);
    expect(() => placeholder.repoUrl).toThrow(/git: not found/);
    expect(() => placeholder.backendType).toThrow(/unavailable/);
  });

  test("placeholder field WRITES throw — no silent mutation masking the deferred state", async () => {
    const placeholder = await resolveRepositoryBackendForBoot(failingDetect);

    expect(() => {
      (placeholder as { repoUrl: string }).repoUrl = "https://example.com/x.git";
    }).toThrow(/unavailable/);
  });

  test("placeholder inspection is benign: stringification and symbol/constructor reads do not throw", async () => {
    const placeholder = await resolveRepositoryBackendForBoot(failingDetect);

    expect(() => String(placeholder)).not.toThrow();
    expect(String(placeholder)).toContain("unavailable repositoryBackend");
    expect(() => JSON.stringify(placeholder)).not.toThrow();
    expect((placeholder as { constructor?: unknown }).constructor).toBeUndefined();
  });

  test("detection failure defers: initialize() completes, sibling services resolve, field read throws", async () => {
    const c = new TsyringeContainer();
    c.register(REPOSITORY_BACKEND_KEY as never, () =>
      resolveRepositoryBackendForBoot(failingDetect)
    );
    c.register("taskService" as never, () => ({ healthy: true }) as never);

    // The git-less-environment failure must NOT abort boot.
    await c.initialize();

    // Sibling services resolve normally.
    expect((c.get("taskService" as never) as { healthy: boolean }).healthy).toBe(true);

    // The deferred placeholder throws the clear error on first field read.
    const rb = c.get(REPOSITORY_BACKEND_KEY as never) as RepositoryBackendConfig;
    expect(() => rb.repoUrl).toThrow(/unavailable/);
    expect(() => rb.repoUrl).toThrow(/git: not found/);
  });
});
