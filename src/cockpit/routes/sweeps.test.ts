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
});
