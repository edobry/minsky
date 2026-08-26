import { describe, expect, test } from "bun:test";

import {
  computeMetricsSnapshot,
  deriveRestartCount,
  notifyStatusObserved,
  notifyProgress,
  railwayAdapterFactory,
  RailwayDeploymentAdapter,
  parseNotBefore,
  acquireDeploymentAtOrAfter,
  toRecord,
} from "./adapter";
import type { DeploymentConfig } from "../config";
import type { DeploymentRecord } from "../types";
import { NoDeploymentSinceError } from "../types";
import type { RailwayDeploymentNode, RailwayMetricSeries } from "./graphql-client";

describe("railwayAdapterFactory", () => {
  test("builds a RailwayDeploymentAdapter from a railway config", () => {
    const config: DeploymentConfig = {
      platform: "railway",
      railway: { projectId: "p", environmentId: "e", serviceId: "s" },
    };
    const adapter = railwayAdapterFactory(config);
    expect(adapter).toBeInstanceOf(RailwayDeploymentAdapter);
  });

  test("throws when called with a non-railway platform", () => {
    const config = {
      platform: "vercel",
      vercel: {},
    } as unknown as DeploymentConfig;

    expect(() => railwayAdapterFactory(config)).toThrow(/non-railway/);
  });
});

// ---------------------------------------------------------------------------
// computeMetricsSnapshot (mt#2296)
// ---------------------------------------------------------------------------

function series(measurement: string, values: [number, number][]): RailwayMetricSeries {
  return { measurement, values: values.map(([ts, value]) => ({ ts, value })) };
}

describe("computeMetricsSnapshot", () => {
  test("derives CPU% and memory% from usage/limit, picking the latest datapoint", () => {
    const snap = computeMetricsSnapshot([
      series("CPU_USAGE", [
        [100, 0.5],
        [200, 2], // latest
      ]),
      series("CPU_LIMIT", [
        [100, 8],
        [200, 8],
      ]),
      series("MEMORY_USAGE_GB", [[200, 0.5]]),
      series("MEMORY_LIMIT_GB", [[200, 2]]),
    ]);
    expect(snap.cpuPercent).toBeCloseTo(25); // 2 / 8 * 100
    expect(snap.memoryPercent).toBeCloseTo(25); // 0.5 / 2 * 100
    expect(snap.cpuUsageVCpu).toBe(2);
    expect(snap.cpuLimitVCpu).toBe(8);
    expect(snap.memoryUsageGb).toBe(0.5);
    expect(snap.memoryLimitGb).toBe(2);
    expect(snap.sampledAt).toBe(new Date(200 * 1000).toISOString());
  });

  test("returns null percentage when a series is missing", () => {
    const snap = computeMetricsSnapshot([
      series("CPU_USAGE", [[100, 1]]),
      series("CPU_LIMIT", [[100, 4]]),
      // no memory series
    ]);
    expect(snap.cpuPercent).toBeCloseTo(25);
    expect(snap.memoryPercent).toBeNull();
    expect(snap.memoryUsageGb).toBeNull();
    expect(snap.memoryLimitGb).toBeNull();
  });

  test("returns null percentage on a zero limit (no divide-by-zero)", () => {
    const snap = computeMetricsSnapshot([
      series("CPU_USAGE", [[100, 1]]),
      series("CPU_LIMIT", [[100, 0]]),
    ]);
    expect(snap.cpuPercent).toBeNull();
    expect(snap.cpuUsageVCpu).toBe(1);
    expect(snap.cpuLimitVCpu).toBe(0);
  });

  test("returns all-null on empty input", () => {
    const snap = computeMetricsSnapshot([]);
    expect(snap.cpuPercent).toBeNull();
    expect(snap.memoryPercent).toBeNull();
    expect(snap.sampledAt).toBeNull();
  });

  test("ignores an empty values array for a present series", () => {
    const snap = computeMetricsSnapshot([series("CPU_USAGE", []), series("CPU_LIMIT", [[100, 8]])]);
    expect(snap.cpuPercent).toBeNull();
    expect(snap.cpuUsageVCpu).toBeNull();
    expect(snap.cpuLimitVCpu).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// deriveRestartCount (mt#2296)
// ---------------------------------------------------------------------------

function node(id: string, status: string, createdAt: string): RailwayDeploymentNode {
  return { id, status, createdAt };
}

describe("deriveRestartCount", () => {
  const now = Date.parse("2026-06-04T12:00:00.000Z");

  test("counts deployments created within the window and breaks down by status", () => {
    const nodes = [
      node("a", "SUCCESS", "2026-06-04T11:00:00.000Z"), // in window
      node("b", "FAILED", "2026-06-04T10:00:00.000Z"), // in window
      node("c", "FAILED", "2026-06-04T09:00:00.000Z"), // in window
      node("d", "SUCCESS", "2026-06-02T09:00:00.000Z"), // outside 24h
    ];
    const result = deriveRestartCount(nodes, 24, now);
    expect(result.count).toBe(3);
    expect(result.windowHours).toBe(24);
    expect(result.since).toBe(new Date(now - 24 * 3600 * 1000).toISOString());
    expect(result.byStatus.SUCCESS).toBe(1);
    expect(result.byStatus.FAILED).toBe(2);
  });

  test("respects a custom window", () => {
    const nodes = [
      node("a", "SUCCESS", "2026-06-04T11:30:00.000Z"), // within 1h
      node("b", "FAILED", "2026-06-04T10:30:00.000Z"), // outside 1h
    ];
    const result = deriveRestartCount(nodes, 1, now);
    expect(result.count).toBe(1);
    expect(result.byStatus.SUCCESS).toBe(1);
    expect(result.byStatus.FAILED).toBeUndefined();
  });

  test("ignores nodes with an unparseable createdAt", () => {
    const nodes = [
      node("a", "SUCCESS", "not-a-date"),
      node("b", "SUCCESS", "2026-06-04T11:00:00.000Z"),
    ];
    const result = deriveRestartCount(nodes, 24, now);
    expect(result.count).toBe(1);
  });

  test("returns an empty breakdown when nothing is in window", () => {
    const result = deriveRestartCount([node("a", "SUCCESS", "2020-01-01T00:00:00.000Z")], 24, now);
    expect(result.count).toBe(0);
    expect(result.byStatus).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// notifyStatusObserved (mt#2599) — best-effort onStatusObserved invocation
// ---------------------------------------------------------------------------

function deploymentRecord(status: DeploymentRecord["status"]): DeploymentRecord {
  return {
    id: "dep-1",
    status,
    commitHash: "abc123",
    commitMessage: "test commit",
    imageDigest: null,
    createdAt: "2026-01-01T00:00:00Z",
    finishedAt: null,
    durationMs: null,
    url: null,
  };
}

describe("notifyStatusObserved", () => {
  test("is a no-op when onStatusObserved is undefined", async () => {
    await expect(
      notifyStatusObserved(undefined, deploymentRecord("BUILDING"))
    ).resolves.toBeUndefined();
  });

  test("invokes the callback with the observed record", async () => {
    const seen: DeploymentRecord[] = [];
    await notifyStatusObserved((record) => {
      seen.push(record);
    }, deploymentRecord("BUILDING"));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.status).toBe("BUILDING");
  });

  test("awaits an async callback", async () => {
    let resolved = false;
    await notifyStatusObserved(async () => {
      await Promise.resolve();
      resolved = true;
    }, deploymentRecord("DEPLOYING"));
    expect(resolved).toBe(true);
  });

  test("swallows a synchronously-thrown callback error (best-effort)", async () => {
    await expect(
      notifyStatusObserved(() => {
        throw new Error("boom");
      }, deploymentRecord("BUILDING"))
    ).resolves.toBeUndefined();
  });

  test("swallows a rejected async callback (best-effort)", async () => {
    await expect(
      notifyStatusObserved(async () => {
        throw new Error("async boom");
      }, deploymentRecord("SUCCESS"))
    ).resolves.toBeUndefined();
  });
});

/**
 * mt#3890: the post-merge deploy gate must be able to FAIL.
 *
 * Originating incident: `minsky-mcp`'s workflow redeploy step was returning
 * `Not Authorized` and treating it as non-fatal, so no deployment was created
 * for ~4.5 days. `waitForLatestDeployment` returned the 2026-08-05 SUCCESS
 * record to every post-merge gate that asked, and every one of them passed.
 * The dates below are the real ones from that incident.
 */
describe("notBefore bound on deployment waits (mt#3890)", () => {
  const STALE = "2026-08-05T23:31:02.995Z";
  const MERGE = "2026-08-09T03:50:26.330Z";

  function node(createdAt: string, id = "dep-1", status = "SUCCESS") {
    return { id, status, createdAt, meta: null, staticUrl: null };
  }

  function neverSleep() {
    return Promise.resolve();
  }

  describe("parseNotBefore", () => {
    test("returns null when unset, so legacy callers keep the old behavior", () => {
      expect(parseNotBefore(undefined)).toBeNull();
    });

    test("parses a valid ISO8601 timestamp", () => {
      expect(parseNotBefore(MERGE)).toBe(Date.parse(MERGE));
    });

    test("throws on a malformed value rather than silently dropping the bound", () => {
      expect(() => parseNotBefore("not-a-timestamp")).toThrow(/not a valid ISO8601/);
    });
  });

  describe("acquireDeploymentAtOrAfter", () => {
    test("REJECTS a deployment predating the bound and reports how stale it is", async () => {
      let calls = 0;
      const promise = acquireDeploymentAtOrAfter({
        fetchNewest: async () => {
          calls++;
          return node(STALE);
        },
        notBeforeMs: Date.parse(MERGE),
        notBefore: MERGE,
        timeoutSeconds: 600,
        deadlineMs: 1000,
        now: () => 2000,
        sleep: neverSleep,
        pollIntervalMs: 10,
      });

      await expect(promise).rejects.toThrow(NoDeploymentSinceError);
      await promise.catch((e: NoDeploymentSinceError) => {
        expect(e.newestRecord?.createdAt).toBe(STALE);
        expect(e.notBefore).toBe(MERGE);
        expect(e.message).toContain("never triggered");
      });
      expect(calls).toBe(1);
    });

    test("ACCEPTS a deployment created at or after the bound", async () => {
      const fresh = node(MERGE, "dep-fresh");
      const got = await acquireDeploymentAtOrAfter({
        fetchNewest: async () => fresh,
        notBeforeMs: Date.parse(MERGE),
        notBefore: MERGE,
        timeoutSeconds: 600,
        deadlineMs: Number.MAX_SAFE_INTEGER,
        now: () => 0,
        sleep: neverSleep,
        pollIntervalMs: 10,
      });
      expect(got?.id).toBe("dep-fresh");
    });

    test("polls past a stale record until a qualifying one appears", async () => {
      const sequence = [node(STALE), node(STALE), node("2026-08-09T03:52:00.000Z", "dep-new")];
      let i = 0;
      const got = await acquireDeploymentAtOrAfter({
        fetchNewest: async () => sequence[Math.min(i++, sequence.length - 1)],
        notBeforeMs: Date.parse(MERGE),
        notBefore: MERGE,
        timeoutSeconds: 600,
        deadlineMs: Number.MAX_SAFE_INTEGER,
        now: () => 0,
        sleep: neverSleep,
        pollIntervalMs: 10,
      });
      expect(got?.id).toBe("dep-new");
      expect(i).toBe(3);
    });

    test("reports null newestRecord when the service has no deployments at all", async () => {
      const promise = acquireDeploymentAtOrAfter({
        fetchNewest: async () => undefined,
        notBeforeMs: Date.parse(MERGE),
        notBefore: MERGE,
        timeoutSeconds: 600,
        deadlineMs: 1000,
        now: () => 2000,
        sleep: neverSleep,
        pollIntervalMs: 10,
      });
      await expect(promise).rejects.toThrow(NoDeploymentSinceError);
      await promise.catch((e: NoDeploymentSinceError) => {
        expect(e.newestRecord).toBeNull();
        expect(e.message).toContain("No deployments exist");
      });
    });

    test("without a bound, returns whatever is newest — the pre-mt#3890 contract", async () => {
      const got = await acquireDeploymentAtOrAfter({
        fetchNewest: async () => node(STALE),
        notBeforeMs: null,
        notBefore: undefined,
        timeoutSeconds: 600,
        deadlineMs: 0,
        now: () => 999999,
        sleep: neverSleep,
        pollIntervalMs: 10,
      });
      expect(got?.createdAt).toBe(STALE);
    });

    describe("mt#1576 — the acquire phase emits transport progress", () => {
      test("emits once per polling iteration, not just at the end", async () => {
        // The acquire loop reached `notifyStatusObserved` NOT AT ALL before
        // mt#1576 — the first status notify fires only after this returns. A
        // post-merge wait passing `notBefore` spends most of its life here, so
        // this loop staying silent is what the transport's idle timeout killed.
        const sequence = [node(STALE), node(STALE), node("2026-08-09T03:52:00.000Z", "dep-new")];
        let i = 0;
        const messages: string[] = [];
        await acquireDeploymentAtOrAfter({
          fetchNewest: async () => sequence[Math.min(i++, sequence.length - 1)],
          notBeforeMs: Date.parse(MERGE),
          notBefore: MERGE,
          timeoutSeconds: 600,
          deadlineMs: Number.MAX_SAFE_INTEGER,
          now: () => 0,
          sleep: neverSleep,
          pollIntervalMs: 10,
          onPoll: (m) => messages.push(m),
        });
        // Two sleeps happen before the qualifying record arrives on the third
        // fetch, so two emissions — one per idle window, which is the property
        // that matters rather than the absolute count.
        expect(messages.length).toBe(2);
        expect(messages[0]).toContain(MERGE);
        expect(messages[0]).toContain(STALE);
      });

      test("reports that nothing has been seen yet when the service is empty", async () => {
        const messages: string[] = [];
        const promise = acquireDeploymentAtOrAfter({
          fetchNewest: async () => undefined,
          notBeforeMs: Date.parse(MERGE),
          notBefore: MERGE,
          timeoutSeconds: 600,
          deadlineMs: 1000,
          now: (() => {
            // Below the deadline once so one iteration runs, then past it.
            let n = 0;
            return () => (n++ === 0 ? 0 : 2000);
          })(),
          sleep: neverSleep,
          pollIntervalMs: 10,
          onPoll: (m) => messages.push(m),
        });
        await expect(promise).rejects.toThrow(NoDeploymentSinceError);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain("none seen yet");
      });

      test("PR #3384 R1 — a throwing onPoll does not abort the acquire loop", async () => {
        // The swallow has to live INSIDE this exported function, not only at the
        // one call site in `waitForLatestDeployment` that wraps it: a direct
        // caller passing a throwing reporter would otherwise lose the wait, and
        // the `onPoll` docblock promises best-effort to every caller.
        const sequence = [node(STALE), node("2026-08-09T03:52:00.000Z", "dep-new")];
        let i = 0;
        const got = await acquireDeploymentAtOrAfter({
          fetchNewest: async () => sequence[Math.min(i++, sequence.length - 1)],
          notBeforeMs: Date.parse(MERGE),
          notBefore: MERGE,
          timeoutSeconds: 600,
          deadlineMs: Number.MAX_SAFE_INTEGER,
          now: () => 0,
          sleep: neverSleep,
          pollIntervalMs: 10,
          onPoll: () => {
            throw new Error("reporter exploded");
          },
        });
        // The wait still resolves to the qualifying deployment.
        expect(got?.id).toBe("dep-new");
      });

      test("omitting onPoll leaves the loop working — the CLI path", async () => {
        // The callback is optional; the CLI supplies nothing and must not break.
        const got = await acquireDeploymentAtOrAfter({
          fetchNewest: async () => node("2026-08-09T03:52:00.000Z", "dep-new"),
          notBeforeMs: Date.parse(MERGE),
          notBefore: MERGE,
          timeoutSeconds: 600,
          deadlineMs: Number.MAX_SAFE_INTEGER,
          now: () => 0,
          sleep: neverSleep,
          pollIntervalMs: 10,
        });
        expect(got?.id).toBe("dep-new");
      });
    });
  });

  describe("mt#1576 — notifyProgress is best-effort", () => {
    test("a throwing reporter is swallowed rather than aborting the wait", () => {
      expect(() =>
        notifyProgress(() => {
          throw new Error("reporter exploded");
        }, "still waiting")
      ).not.toThrow();
    });

    test("an absent reporter is a no-op", () => {
      expect(() => notifyProgress(undefined, "still waiting")).not.toThrow();
    });

    test("a working reporter receives the message verbatim", () => {
      const seen: string[] = [];
      notifyProgress((m) => seen.push(m), "deployment dep-1: BUILDING");
      expect(seen).toEqual(["deployment dep-1: BUILDING"]);
    });
  });
});

// ---------------------------------------------------------------------------
// toRecord — meta mapping (mt#4583)
// ---------------------------------------------------------------------------
//
// The digest was already arriving: the deployments query selects `meta` as a
// whole JSON scalar. It was discarded here, which is why the caller had no
// discriminator to reason with.

describe("toRecord meta mapping (mt#4583)", () => {
  const base = { id: "dep-1", status: "SUCCESS", createdAt: "2026-08-25T17:19:04Z" };

  test("surfaces imageDigest from meta", () => {
    const record = toRecord({
      ...base,
      meta: { imageDigest: "sha256:deadbeef" },
    } as Parameters<typeof toRecord>[0]);

    expect(record.imageDigest).toBe("sha256:deadbeef");
  });

  test("an image-source deployment has a digest and NO commit — the shape that defeats a time bound", () => {
    const record = toRecord({
      ...base,
      meta: { imageDigest: "sha256:deadbeef", image: "ghcr.io/edobry/minsky-reviewer:latest" },
    } as Parameters<typeof toRecord>[0]);

    expect(record.commitHash).toBeNull();
    expect(record.imageDigest).toBe("sha256:deadbeef");
  });

  test("null when meta is absent entirely", () => {
    const record = toRecord({ ...base, meta: null } as Parameters<typeof toRecord>[0]);
    expect(record.imageDigest).toBeNull();
  });

  test("null when the platform returns a non-string digest, rather than surfacing a non-identity", () => {
    const record = toRecord({
      ...base,
      meta: { imageDigest: { unexpected: "shape" } },
    } as unknown as Parameters<typeof toRecord>[0]);

    expect(record.imageDigest).toBeNull();
  });

  test("commitHash still maps for a repo-source deployment", () => {
    const record = toRecord({
      ...base,
      meta: { commitHash: "b65baf940", commitMessage: "feat: x" },
    } as Parameters<typeof toRecord>[0]);

    expect(record.commitHash).toBe("b65baf940");
    expect(record.imageDigest).toBeNull();
  });
});
