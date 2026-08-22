/**
 * Tests for GET /api/sweeps (mt#2894).
 */
import { describe, test, expect, afterEach } from "bun:test";
import type { Server } from "http";
import express from "express";
import { mountSweepRoutes } from "./sweeps";
import { createIntervalSweeper, _resetSweepLivenessRegistryForTest } from "../sweepers";

const servers: Server[] = [];

async function makeHarness(): Promise<{ url: string }> {
  const app = express();
  mountSweepRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no ephemeral port");
  return { url: `http://127.0.0.1:${address.port}` };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  _resetSweepLivenessRegistryForTest();
});

/** Poll `condition` until it's true, or throw after `timeoutMs`. */
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  // eslint-disable-next-line custom/no-real-fs-in-tests -- Date.now() is used for timing, not path creation; the rule's regex fires on the call pattern but there is no filesystem interaction here
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    // eslint-disable-next-line custom/no-real-fs-in-tests -- same: timing, not path creation
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("GET /api/sweeps", () => {
  test("returns an empty list when no sweeps are registered", async () => {
    const { url } = await makeHarness();
    const res = await fetch(`${url}/api/sweeps`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sweeps: unknown[] };
    expect(body.sweeps).toEqual([]);
  });

  test("reports a registered sweep's liveness fields after its boot tick", async () => {
    let calls = 0;
    const stop = createIntervalSweeper({
      name: "test-route-sweep",
      intervalMs: 60_000,
      tickTimeoutMs: 5_000,
      tick: async () => {
        calls++;
        return { ok: true };
      },
    });
    try {
      await waitFor(() => calls >= 1);
      const { url } = await makeHarness();
      const res = await fetch(`${url}/api/sweeps`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        sweeps: Array<{
          name: string;
          intervalMs: number;
          lastAttemptAt: string | null;
          lastSuccessAt: string | null;
          lastErrorAt: string | null;
          consecutiveFailures: number;
          reinits: number;
          metaRestarts: number;
        }>;
      };
      const entry = body.sweeps.find((s) => s.name === "test-route-sweep");
      expect(entry).toBeDefined();
      expect(entry?.intervalMs).toBe(60_000);
      expect(entry?.lastAttemptAt).not.toBeNull();
      expect(entry?.lastSuccessAt).not.toBeNull();
      expect(entry?.lastErrorAt).toBeNull();
      expect(entry?.consecutiveFailures).toBe(0);
      expect(entry?.reinits).toBe(0);
      expect(entry?.metaRestarts).toBe(0);
    } finally {
      stop();
    }
  });

  test("carries a transcriptCoverage block — output, not just liveness (mt#3441)", async () => {
    const { url } = await makeHarness();
    const res = await fetch(`${url}/api/sweeps`);
    const body = (await res.json()) as Record<string, unknown>;

    // The KEY must be present even with no SQL persistence in the harness.
    // A sweep can be alive and producing nothing — SummaryPipeline sat at 0.5%
    // coverage for months with a green liveness registry — so this route
    // reports both, and the field's presence is what makes the second
    // observable at all.
    expect(Object.hasOwn(body, "transcriptCoverage")).toBe(true);

    // The VALUE is deliberately not asserted here (mt#3600). This test used to
    // require null, on the premise "no SQL provider in this harness" — false on
    // a machine with Postgres configured, and true-until-a-sibling-test-runs
    // even there, because the provider is a process-wide singleton. That made
    // an unrelated commit's pre-commit gate fail depending on which other files
    // shared the batch. Both value branches, and the measured-zero vs
    // not-measured distinction this route exists to preserve, are pinned in
    // `src/cockpit/transcript-coverage.test.ts` against an EXPLICIT provider.
    // Here we only require the shape to be one of the two legal ones.
    const coverage = body.transcriptCoverage;
    expect(coverage === null || typeof coverage === "object").toBe(true);
    if (coverage !== null) {
      expect(Object.hasOwn(coverage as object, "total")).toBe(true);
      expect(Object.hasOwn(coverage as object, "titlePct")).toBe(true);
    }
  });
});
