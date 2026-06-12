/**
 * Tests for lazy repository-backend resolution (mt#1428, supersedes mt#2460).
 *
 * Repository-backend detection is environment-dependent: with no
 * `repository.backend` config it shells out to `git remote get-url origin` in
 * `process.cwd()`. Running it eagerly at container boot made every CLI command
 * spawn git (and crash or leak `fatal:` noise outside a git checkout), and
 * broke deployed headless containers with no git binary (mt#2460).
 *
 * Detection is now LAZY: `makeLazyRepositoryBackendResolver()` builds the
 * `sessionDeps.getRepositoryBackend` thunk, and detection runs only on its
 * first call. Container boot never invokes detection at all — which subsumes
 * mt#2460's boot-time deferred-failure placeholder (boot cannot fail on a
 * mechanism that never runs at boot).
 */

import { describe, test, expect } from "bun:test";
import { createDomainContainer, makeLazyRepositoryBackendResolver } from "./domain";
import { RepositoryBackendType } from "../repository/index";

const detected = {
  repoUrl: "https://github.com/edobry/minsky.git",
  backendType: RepositoryBackendType.GITHUB,
  github: { owner: "edobry", repo: "minsky" },
};

const failingDetect = async (): Promise<typeof detected> => {
  throw new Error(
    "Default repository backend is GitHub, but could not detect GitHub remote: git: not found"
  );
};

describe("makeLazyRepositoryBackendResolver (mt#1428)", () => {
  test("detection does not run until the resolver is called", async () => {
    let calls = 0;
    const resolver = makeLazyRepositoryBackendResolver(async () => {
      calls += 1;
      return detected;
    });

    expect(calls).toBe(0);
    await resolver();
    expect(calls).toBe(1);
  });

  test("successful detection passes the result through unchanged and is memoized", async () => {
    let calls = 0;
    const resolver = makeLazyRepositoryBackendResolver(async () => {
      calls += 1;
      return detected;
    });

    const first = await resolver();
    const second = await resolver();
    expect(first).toEqual(detected);
    expect(second).toBe(first);
    expect(calls).toBe(1);
  });

  test("detection failure propagates the clear underlying error to the caller", async () => {
    const resolver = makeLazyRepositoryBackendResolver(failingDetect);
    await expect(resolver()).rejects.toThrow(/could not detect GitHub remote/);
  });

  test("failures are NOT memoized — a later call retries detection", async () => {
    let calls = 0;
    const resolver = makeLazyRepositoryBackendResolver(async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient: git: not found");
      return detected;
    });

    await expect(resolver()).rejects.toThrow(/transient/);
    const result = await resolver();
    expect(result).toEqual(detected);
    expect(calls).toBe(2);
  });

  test("concurrent calls share one in-flight detection", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const resolver = makeLazyRepositoryBackendResolver(async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return detected;
    });

    const a = resolver();
    const b = resolver();
    release?.();
    expect(await a).toEqual(detected);
    expect(await b).toEqual(detected);
    expect(calls).toBe(1);
  });
});

describe("createDomainContainer repository-backend laziness (mt#1428)", () => {
  test("container boot never invokes git-remote detection — git-less environments boot", async () => {
    // The mt#2460 failure mode: a headless container (no git binary, no .git)
    // crashed at initialize() because the repositoryBackend factory ran
    // detection eagerly. With lazy resolution there is no repositoryBackend
    // factory at all — assert the key is gone from the registration set, so
    // boot structurally cannot run detection.
    const container = await createDomainContainer();
    expect(container.has("repositoryBackend" as never)).toBe(false);
  });
});
