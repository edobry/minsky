/**
 * Contract test pinning the `/api/health` response shape against the shared
 * golden fixture consumed by the Rust tray supervisor (mt#2629).
 *
 * `contract/cockpit-health-shape.json` at the repo root is the single
 * checked-in source of truth for the field set + per-field types this route
 * emits. The Rust side (`cockpit-tray/src-tauri/src/supervisor.rs`'s
 * `health_contract` test module) reads the SAME fixture via `include_str!`
 * and additionally scans the literal TypeScript source of `./routes/health.ts`
 * for the field names it depends on (`db`, `processStartedAtMs`). Renaming,
 * removing, or re-typing any field emitted here fails THIS test immediately;
 * renaming one of the two Rust-consumed fields also fails the cargo test.
 * See `contract/README.md` for the full contract note.
 *
 * @see contract/cockpit-health-shape.json
 * @see contract/README.md
 * @see cockpit-tray/src-tauri/src/supervisor.rs — `health_contract` test module
 */
import { describe, test, expect, afterEach } from "bun:test";
import { createServer } from "http";
import type { Server } from "http";
import { createCockpitServer } from "./server";
// Static JSON import (resolveJsonModule) — the checked-in golden fixture IS
// the contract under test, so no fs access is needed (and the
// custom/no-real-fs-in-tests rule stays satisfied without an exception).
import healthShapeFixtureJson from "../../contract/cockpit-health-shape.json";
import { refreshProdStateCache, type UnsafeSql } from "./prod-state-cache";
import {
  refreshDbReachability,
  getDbStatus,
  __resetSharedPersistenceForTests,
} from "./shared-persistence";
import { ProdStateSweepTracker } from "./prod-state-sweep-tracker";
import { TranscriptWatcherTracker } from "./transcript-watcher-tracker";
/* eslint-disable custom/no-real-fs-in-tests -- the acceptance-test-2 case below writes to an
   explicit tmp path (never the real default cache path) to prove refreshProdStateCache's
   write-then-read round trip through the live /api/health route; mirrors prod-state-cache.test.ts */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

interface HealthShapeFixture {
  fields: Record<string, string>;
}

function loadFixture(): HealthShapeFixture {
  return healthShapeFixtureJson as unknown as HealthShapeFixture;
}

/** Map a JS runtime value to the coarse type vocabulary used by the fixture. */
function typeOf(value: unknown): string {
  if (value === null) return "object"; // JSON null has no dedicated slot here; unused by this route.
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// mt#2538: createCockpitServer now generates/persists a real bearer token on
// first use unless overridden — pass a fixed test token so these GET-only
// tests never touch ~/.local/state/minsky/cockpit-token.
const TEST_TOKEN = "test-health-contract-token";

async function startTestServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = createCockpitServer({ overrideToken: TEST_TOKEN });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("unexpected addr shape");
  const url = `http://127.0.0.1:${addr.port}`;
  const close = () =>
    new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return { url, close };
}

describe("Cockpit /api/health contract (mt#2629)", () => {
  const closeList: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closeList.splice(0)) {
      await close();
    }
  });

  test("live response field set matches the shared golden fixture exactly", async () => {
    const fixture = loadFixture();
    const { url, close } = await startTestServer();
    closeList.push(close);

    const res = await fetch(`${url}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    const fixtureFields = Object.keys(fixture.fields).sort();
    const actualFields = Object.keys(body).sort();

    // Exact set equality — a field added, removed, or renamed in health.ts
    // must be reflected in contract/cockpit-health-shape.json in the same PR.
    expect(actualFields).toEqual(fixtureFields);
  });

  test("live response field types match the shared golden fixture", async () => {
    const fixture = loadFixture();
    const { url, close } = await startTestServer();
    closeList.push(close);

    const res = await fetch(`${url}/api/health`);
    const body = (await res.json()) as Record<string, unknown>;

    for (const [field, expectedType] of Object.entries(fixture.fields)) {
      expect(body).toHaveProperty(field);
      expect(typeOf(body[field])).toBe(expectedType);
    }
  });

  test("fixture's rustConsumedFields are a subset of its own fields", async () => {
    // Self-consistency guard on the fixture file itself: the field names the
    // Rust supervisor is documented to depend on must actually be declared
    // in `fields` — otherwise the cargo-side pin (see supervisor.rs) would be
    // checking a field this fixture doesn't even claim to emit.
    const parsed = healthShapeFixtureJson as unknown as HealthShapeFixture & {
      rustConsumedFields: string[];
    };
    for (const field of parsed.rustConsumedFields) {
      expect(Object.keys(parsed.fields)).toContain(field);
    }
  });

  // mt#3857. The rest of this fixture pins only the TOP-LEVEL field set, so
  // `transcriptWatcher: "object"` was satisfied by any contents whatsoever —
  // which is how a 1,380-entry / 209 KB array rode inside it, on the endpoint
  // the tray polls every 5s. These three tests are the CI teeth: the nested
  // type pin, and the two semantic invariants a re-inflation would break.
  test("transcriptWatcher's nested field set and types match the fixture", async () => {
    const parsed = healthShapeFixtureJson as unknown as {
      transcriptWatcherFields: Record<string, string>;
    };
    const { url, close } = await startTestServer();
    closeList.push(close);

    const res = await fetch(`${url}/api/health`);
    const body = (await res.json()) as { transcriptWatcher: Record<string, unknown> };

    expect(Object.keys(body.transcriptWatcher).sort()).toEqual(
      Object.keys(parsed.transcriptWatcherFields).sort()
    );
    for (const [field, expectedType] of Object.entries(parsed.transcriptWatcherFields)) {
      expect(body.transcriptWatcher).toHaveProperty(field);
      expect(typeOf(body.transcriptWatcher[field])).toBe(expectedType);
    }
  });

  test("activeSessions is bounded by the live window, not the registry size", async () => {
    // The exact shape of the defect: a large registry of sessions the watcher
    // knows about but has seen no recent activity in. Pre-mt#3857 all of these
    // shipped in the response; now none of them may.
    const tracker = TranscriptWatcherTracker.resetForTest();
    for (let i = 0; i < 500; i++) {
      tracker.recordSessionSeeded(`contract-seeded-${i}`, false);
    }
    tracker.recordSessionEvent("contract-genuinely-live", false);

    const { url, close } = await startTestServer();
    closeList.push(close);

    const res = await fetch(`${url}/api/health`);
    const body = (await res.json()) as {
      transcriptWatcher: {
        activeSessionCount: number;
        activeSessions: Array<{ agentSessionId: string }>;
      };
    };

    // The registry still knows about all 501 ...
    expect(body.transcriptWatcher.activeSessionCount).toBe(501);
    // ... but only the one with real activity is on the wire.
    expect(body.transcriptWatcher.activeSessions).toHaveLength(1);
    expect(body.transcriptWatcher.activeSessions[0]?.agentSessionId).toBe(
      "contract-genuinely-live"
    );
  });

  test("the health payload does not grow with transcript history", async () => {
    // Size assertion in bytes, because the invariant that matters to the tray is
    // "this response stays small", and a field-shape test cannot express that.
    // Threshold is mt#3857's SC1 (4 KB); the measured post-fix payload against a
    // 1,380-file history was 1,642 bytes.
    const tracker = TranscriptWatcherTracker.resetForTest();
    for (let i = 0; i < 2000; i++) {
      tracker.recordSessionSeeded(`contract-history-${i}`, false);
    }

    const { url, close } = await startTestServer();
    closeList.push(close);

    const res = await fetch(`${url}/api/health`);
    const text = await res.text();

    expect(JSON.parse(text).transcriptWatcher.activeSessionCount).toBe(2000);
    expect(text.length).toBeLessThan(4096);
  });

  test("prodStateSweep block reflects real sweep outcomes under normal operation (mt#3039 acceptance test 2)", async () => {
    ProdStateSweepTracker.resetForTest();
    const okSql: UnsafeSql = {
      unsafe: async () => [{ total: 7, latest_at: "1718500000000" }],
    };
    // Explicit tmp cachePath — must NOT touch the real default state-dir
    // cache file that a live cockpit daemon reads/writes.
    const tmpPath = path.join(
      os.tmpdir(),
      `minsky-health-contract-prod-state-${process.pid}-${crypto.randomUUID()}.json`
    );
    try {
      // Run the real producer function once (as the sweep tick does) so the
      // process-lifetime tracker singleton — the same one health.ts reads —
      // carries a genuine outcome, not just its zero-filled default.
      await refreshProdStateCache(okSql, new Date().toISOString(), tmpPath);

      const { url, close } = await startTestServer();
      closeList.push(close);
      const res = await fetch(`${url}/api/health`);
      const body = (await res.json()) as { prodStateSweep: Record<string, unknown> };

      expect(body.prodStateSweep.runsCount).toBe(1);
      expect(body.prodStateSweep.lastSuccessAt).not.toBeNull();
      expect(body.prodStateSweep.consecutiveFailures).toBe(0);
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
    }
  });
});

describe("/api/health while the database is wedged (mt#3563)", () => {
  const closeList: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closeList.splice(0)) {
      await close();
    }
    __resetSharedPersistenceForTests();
  });

  // Scope note (mem#704 — a probe must be able to fail): the elapsed-time
  // assertion below does NOT discriminate awaiting-vs-not, because with a probe
  // already outstanding refreshDbReachability returns early either way. What
  // this test pins is the wedged-state RESPONSE CONTRACT: still 200, and `db`
  // no longer "ok". The non-blocking property is evidenced separately by the
  // live run recorded in the task spec, where the probe measured 223–353 ms
  // while /api/health answered in ~2 ms — an awaiting handler could not.
  test("still answers 200 but reports a non-ok db when a probe is outstanding", async () => {
    // Put the module into the exact state the incidents produced: a probe was
    // issued and never came back. This is the state in which the route must
    // NOT block — awaiting the probe here would make /api/health as slow as
    // the database it reports on, and ADR-014 makes this endpoint the tray's
    // liveness/adoption signal.
    await refreshDbReachability(() => new Promise<never>(() => {}), 20);
    expect(getDbStatus()).not.toBe("ok");

    const { url, close } = await startTestServer();
    closeList.push(close);

    const startedAt = Date.now();
    const res = await fetch(`${url}/api/health`);
    const elapsedMs = Date.now() - startedAt;
    const body = (await res.json()) as Record<string, unknown>;

    // HTTP 200 regardless of DB state — the status code is the tray's liveness
    // signal, so DB truth rides in the body (same split as `schema`).
    expect(res.status).toBe(200);
    expect(body.db).not.toBe("ok");
    expect(elapsedMs).toBeLessThan(1000);
  });
});
