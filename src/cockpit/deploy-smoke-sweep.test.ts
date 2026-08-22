import { describe, test, expect, beforeEach } from "bun:test";
import {
  deriveSmokeStatus,
  triggerDeploySmokeSweep,
  resetDeploySmokeSweepStateForTests,
  BUNDLE_BOOT_SMOKE_CHECK_NAME,
  type CheckRunLike,
  type DeploySmokeSweepDeps,
} from "./deploy-smoke-sweep";

function checkRun(overrides: Partial<CheckRunLike> = {}): CheckRunLike {
  return {
    name: BUNDLE_BOOT_SMOKE_CHECK_NAME,
    status: "completed",
    conclusion: "success",
    ...overrides,
  };
}

describe("deriveSmokeStatus", () => {
  test("returns 'success' when bundle-boot-smoke completed with conclusion success", () => {
    expect(deriveSmokeStatus([checkRun()])).toBe("success");
  });

  test("returns 'failure' when bundle-boot-smoke completed with conclusion failure", () => {
    expect(deriveSmokeStatus([checkRun({ conclusion: "failure" })])).toBe("failure");
  });

  test("returns 'failure' for other terminal conclusions (cancelled, timed_out, etc.)", () => {
    expect(deriveSmokeStatus([checkRun({ conclusion: "cancelled" })])).toBe("failure");
    expect(deriveSmokeStatus([checkRun({ conclusion: "timed_out" })])).toBe("failure");
    expect(deriveSmokeStatus([checkRun({ conclusion: "action_required" })])).toBe("failure");
  });

  test("returns null when the check-run is still in progress", () => {
    expect(deriveSmokeStatus([checkRun({ status: "in_progress", conclusion: null })])).toBeNull();
  });

  test("returns null when the check-run is queued", () => {
    expect(deriveSmokeStatus([checkRun({ status: "queued", conclusion: null })])).toBeNull();
  });

  test("returns null when bundle-boot-smoke is not present at all", () => {
    expect(deriveSmokeStatus([checkRun({ name: "some-other-check" })])).toBeNull();
  });

  test("returns null for an empty check-run list", () => {
    expect(deriveSmokeStatus([])).toBeNull();
  });

  test("finds bundle-boot-smoke among other unrelated checks", () => {
    const checks = [
      checkRun({ name: "lint", conclusion: "success" }),
      checkRun({ name: "typecheck", conclusion: "success" }),
      checkRun({ conclusion: "success" }),
    ];
    expect(deriveSmokeStatus(checks)).toBe("success");
  });
});

describe("triggerDeploySmokeSweep", () => {
  beforeEach(() => {
    resetDeploySmokeSweepStateForTests();
  });

  function fakeDeps(overrides: Partial<DeploySmokeSweepDeps> = {}): DeploySmokeSweepDeps {
    return {
      getCommitSha: () => "abc123",
      fetchChecksForSha: async () => [checkRun()],
      ...overrides,
    };
  }

  /** SQL-capable fake provider whose emit path succeeds — dedup only advances
   * on confirmed persistence, so tests exercising the dedup flag need one. */
  function fakeSuccessfulProvider(): any {
    return {
      getDatabaseConnection: async () => ({
        insert: () => ({ values: () => Promise.resolve() }),
      }),
    };
  }

  test("no-ops when there is no commit SHA to check", async () => {
    let fetchCalled = false;
    const deps = fakeDeps({
      getCommitSha: () => null,
      fetchChecksForSha: async () => {
        fetchCalled = true;
        return [checkRun()];
      },
    });
    await triggerDeploySmokeSweep(undefined, deps);
    expect(fetchCalled).toBe(false);
  });

  test("emits deploy.smoke via emitSystemEventFromProvider when the check has completed", async () => {
    // persistenceProvider is `undefined` here — emitSystemEventFromProvider
    // no-ops on an undefined provider without throwing (mirrors
    // emitSystemEventBestEffort's contract), so this test exercises the
    // sweep's own control flow (fetch -> derive -> attempt emit) without a
    // live DB.
    //
    // mt#4412: this asserted `.toBeUndefined()`, which was a statement about
    // the old `void` signature rather than about behavior. With an undefined
    // provider the emit no-ops, and the sweep now REPORTS that as a domain
    // failure — the retry-next-tick path — so `false` is the correct answer
    // and is what the sibling "does NOT advance dedup when the emit no-ops"
    // test already covers from the other side.
    const deps = fakeDeps();
    await expect(triggerDeploySmokeSweep(undefined, deps)).resolves.toBe(false);
  });

  test("does not re-fetch checks for the same commit twice (in-memory dedup)", async () => {
    let fetchCount = 0;
    const deps = fakeDeps({
      fetchChecksForSha: async () => {
        fetchCount++;
        return [checkRun()];
      },
    });
    const provider = fakeSuccessfulProvider();
    await triggerDeploySmokeSweep(provider, deps);
    await triggerDeploySmokeSweep(provider, deps);
    await triggerDeploySmokeSweep(provider, deps);
    expect(fetchCount).toBe(1);
  });

  test("does NOT advance dedup when the emit no-ops — retries next tick and emits once persistence is back", async () => {
    let fetchCount = 0;
    const deps = fakeDeps({
      fetchChecksForSha: async () => {
        fetchCount++;
        return [checkRun()];
      },
    });
    // Tick 1: undefined provider → emit is a no-op → dedup must NOT advance.
    await triggerDeploySmokeSweep(undefined, deps);
    // Tick 2: still no provider → the sweep retries the fetch (not deduped).
    await triggerDeploySmokeSweep(undefined, deps);
    expect(fetchCount).toBe(2);
    // Tick 3: persistence is back → emit succeeds → dedup advances.
    const provider = fakeSuccessfulProvider();
    await triggerDeploySmokeSweep(provider, deps);
    expect(fetchCount).toBe(3);
    // Tick 4: now deduped.
    await triggerDeploySmokeSweep(provider, deps);
    expect(fetchCount).toBe(3);
  });

  test("retries on the next tick when the check hasn't completed yet", async () => {
    let fetchCount = 0;
    const deps = fakeDeps({
      fetchChecksForSha: async () => {
        fetchCount++;
        return [checkRun({ status: "in_progress", conclusion: null })];
      },
    });
    await triggerDeploySmokeSweep(undefined, deps);
    await triggerDeploySmokeSweep(undefined, deps);
    expect(fetchCount).toBe(2); // not deduped — never successfully completed
  });

  test("checks again when the commit SHA changes (new deploy)", async () => {
    const seenShas: string[] = [];
    let sha = "commit-1";
    const deps = fakeDeps({
      getCommitSha: () => sha,
      fetchChecksForSha: async (s) => {
        seenShas.push(s);
        return [checkRun()];
      },
    });
    const provider = fakeSuccessfulProvider();
    await triggerDeploySmokeSweep(provider, deps);
    sha = "commit-2";
    await triggerDeploySmokeSweep(provider, deps);
    expect(seenShas).toEqual(["commit-1", "commit-2"]);
  });

  test("never throws even when fetchChecksForSha rejects (best-effort)", async () => {
    const deps = fakeDeps({
      fetchChecksForSha: async () => {
        throw new Error("GitHub API unavailable");
      },
    });
    // PR #3237 R1 covers the sibling branch in the test below.
    // mt#4412: the point of this test is that it RESOLVES rather than throws —
    // `.toBeUndefined()` only ever encoded the old `void` return. It now also
    // reports the swallowed throw as a domain failure, which is the stronger
    // assertion: best-effort no longer means invisible.
    await expect(triggerDeploySmokeSweep(undefined, deps)).resolves.toBe(false);
  });

  test("no GitHub backend configured is a domain FAILURE, not a healthy no-op (PR #3237 R1)", async () => {
    // The sweep can never emit `deploy.smoke` without a GitHub backend to query
    // check-runs against, so this is standing inertness. Reporting it as
    // success would make a permanently-inert sweep indistinguishable from a
    // working one on `/api/sweeps` — the exact defect mt#4412 closes, and the
    // one place in that change which contradicted the rule its other 13 sweeps
    // follow.
    const noBackend = async () => null;
    await expect(triggerDeploySmokeSweep(undefined, undefined, noBackend)).resolves.toBe(false);
  });

  test("a capable sweep with nothing to check is healthy (PR #3237 R1, the contrast)", async () => {
    // The discriminating pair for the test above: deps BUILT fine, so the sweep
    // is capable — there is simply no deployed commit to check, which is the
    // local daemon's permanent and correct state. Reporting a standing failure
    // here would be a false alarm on the majority of daemons.
    const capableButNothingToDo = async () => ({
      getCommitSha: () => null,
      fetchChecksForSha: async () => {
        throw new Error("must not be reached — there is no SHA to fetch");
      },
    });
    await expect(
      triggerDeploySmokeSweep(undefined, undefined, capableButNothingToDo)
    ).resolves.toBe(true);
  });
});
