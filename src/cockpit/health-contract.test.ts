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
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
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
import {
  findUndatedLivenessAssertions,
  auditLivenessAssertions,
  describeUndatedLivenessAssertions,
  DECLARED_EXEMPTIONS,
} from "./health-liveness-invariant";
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

  // mt#4489 — the route half of the cwd guard. `findRepoRoot`'s own negative
  // case is covered at web-dist.test.ts:23 with an injected `exists`; what is
  // NOT covered there, and is the entire point of this field, is that the route
  // re-resolves against the LIVE cwd on each request rather than a boot-time
  // constant. A test that only asserted the healthy shape would pass against a
  // hardcoded `resolved: <repo>`, so the flip is asserted directly.
  test("workspaceRoot resolves the repo root from a healthy cwd", async () => {
    const { url, close } = await startTestServer();
    closeList.push(close);

    const res = await fetch(`${url}/api/health`);
    const body = (await res.json()) as {
      workspaceRoot: { cwd: string; resolved: string | null; checkedAt: string };
    };

    expect(body.workspaceRoot.cwd).toBe(process.cwd());
    expect(typeof body.workspaceRoot.resolved).toBe("string");
    expect(Number.isNaN(Date.parse(body.workspaceRoot.checkedAt))).toBe(false);
  });

  test("workspaceRoot reports resolved: null when the cwd is not a repo root", async () => {
    const { url, close } = await startTestServer();
    closeList.push(close);

    // The condition this field exists for is a cwd that STOPS resolving under a
    // running process. Deleting the real cwd mid-test is not available to us, so
    // we move to a directory that cannot resolve — `/` has no `src/cockpit/web`
    // at or above it — which reaches the route through the same code path.
    // Restored in `finally` so a failed assertion cannot leak a bad cwd into
    // any test that runs after this one.
    const original = process.cwd();
    try {
      process.chdir(path.sep);
      const res = await fetch(`${url}/api/health`);
      const body = (await res.json()) as {
        workspaceRoot: { cwd: string; resolved: string | null };
      };
      expect(body.workspaceRoot.resolved).toBeNull();
      expect(body.workspaceRoot.cwd).not.toBe(original);
    } finally {
      process.chdir(original);
    }
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

  test("pid names the process actually SERVING the response (mt#4232)", async () => {
    // Not just "a number is present": the field's whole value is that it
    // identifies a process safe to SIGNAL, so it has to be THIS process rather
    // than anything the handler could have read from elsewhere. Here the server
    // runs in-process, so the serving pid is knowable independently.
    const { url, close } = await startTestServer();
    closeList.push(close);

    const res = await fetch(`${url}/api/health`);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body["pid"]).toBe(process.pid);
    expect(Number.isInteger(body["pid"])).toBe(true);
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

  test("sweepLiveness's nested field set and types match the fixture (mt#4384)", async () => {
    // PR #3240 R1: `.fields.sweepLiveness = "object"` pins that the block EXISTS and
    // is an object; it cannot catch a field added, removed or retyped INSIDE it. That
    // is the same cannot-see-it shape this whole task is about — a surface that does
    // not look at the layer holding the answer — so the block gets the same nested
    // pin `transcriptWatcher` already has.
    const parsed = healthShapeFixtureJson as unknown as {
      sweepLivenessFields: Record<string, string>;
    };
    const { url, close } = await startTestServer();
    closeList.push(close);

    const res = await fetch(`${url}/api/health`);
    const body = (await res.json()) as { sweepLiveness: Record<string, unknown> };

    expect(Object.keys(body.sweepLiveness).sort()).toEqual(
      Object.keys(parsed.sweepLivenessFields).sort()
    );
    for (const [field, expectedType] of Object.entries(parsed.sweepLivenessFields)) {
      expect(body.sweepLiveness).toHaveProperty(field);
      expect(typeOf(body.sweepLiveness[field])).toBe(expectedType);
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

  // The reset must run BEFORE the test, not only after it (mt#3951). The state
  // this module carries is process-global, so an afterEach only protects the
  // files that run LATER — it does nothing for this test's own starting point.
  // refreshDbReachability skips the probe entirely when the status is already
  // "ok" and one finished less than its healthy-state floor ago (see
  // shared-persistence.ts, DB_REACHABILITY_MIN_INTERVAL_MS — deliberately not
  // imported here, since this test must not depend on the floor's value; the
  // reset makes the floor unreachable whatever it is). A preceding file that
  // left that state makes the wedge below unreachable and the status assertion
  // read "ok". That rejected pushes on task/mt-2680 for 32 days: green alone
  // and across src/cockpit, red 4-for-4 in the pre-push gate's changed-file
  // subset, where different files run first.
  //
  // The reset is SYNCHRONOUS (`__resetSharedPersistenceForTests(): void`) — it
  // only clears module-level fields — so there is nothing here to await.
  beforeEach(() => {
    __resetSharedPersistenceForTests();
  });

  afterEach(async () => {
    for (const close of closeList.splice(0)) {
      await close();
    }
    __resetSharedPersistenceForTests();
  });

  // Scope note (mem#704 — a probe must be able to fail): there is deliberately
  // no elapsed-time assertion here. One used to sit at the end of this test and
  // could not discriminate awaiting-vs-not, because with a probe already
  // outstanding refreshDbReachability returns early either way — so it pinned
  // nothing while still failing under load. What this test pins is the
  // wedged-state RESPONSE CONTRACT: still 200, and `db` no longer "ok". The
  // non-blocking property is evidenced separately by the live run recorded in
  // the task spec, where the probe measured 223–353 ms while /api/health
  // answered in ~2 ms — an awaiting handler could not.
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

    const res = await fetch(`${url}/api/health`);
    const body = (await res.json()) as Record<string, unknown>;

    // HTTP 200 regardless of DB state — the status code is the tray's liveness
    // signal, so DB truth rides in the body (same split as `schema`).
    expect(res.status).toBe(200);
    expect(body.db).not.toBe("ok");
  });
});

// mt#4186. Three fields learned the same lesson independently — `db` (mt#3563),
// `dbHealth` (mt#3826), `principalChannel` (mt#4183) — and nothing carried it to the
// next field anyone adds. These tests are what carries it.
//
// Note the check PASSES against today's live payload, by construction: mt#4183 dated
// the last undated field before this shipped. That is not a weak test, it is a
// forward-looking one — the load-bearing case is the invented-sub-object test, which is
// what proves the rule is keyed on shape rather than on an allowlist of today's names.
describe("/api/health liveness-dating invariant (mt#4186)", () => {
  const closeList: Array<() => Promise<void>> = [];

  // AT2 drives the process-global TranscriptWatcherTracker into `running: true`, so it
  // must be put back — both directions. This file already carries the scar: mt#3951's
  // note on the mt#3563 block below records that a process-global left dirty by an
  // EARLIER file made a later test's premise unreachable, green in isolation and red
  // only in the pre-push changed-file subset where a different file runs first. An
  // afterEach alone protects later files but not this block's own starting point, so
  // the reset runs on both edges.
  beforeEach(() => {
    TranscriptWatcherTracker.resetForTest();
  });

  afterEach(async () => {
    for (const close of closeList.splice(0)) {
      await close();
    }
    TranscriptWatcherTracker.resetForTest();
  });

  /** The pre-mt#4183 `principalChannel`, verbatim: a healthy claim nothing can date. */
  const PRE_MT4183_PRINCIPAL_CHANNEL = { state: "running", chatId: 12345 };

  test("AT2: the live payload carries a dating field on every liveness assertion", async () => {
    // Drive ONE real subsystem into an affirmative state before probing.
    //
    // Without this the test is VACUOUS and silently so: in the test harness every
    // subsystem sits quiet — `principalChannel` is `disabled` (no Telegram config),
    // `dbHealth` is not connected, the watcher is not running — so NOTHING asserts
    // liveness and the check inspects zero sub-objects. Measured, not assumed: the
    // first version of this test passed with `dated.length === 0`.
    //
    // `transcriptWatcher` is the right subsystem to seed precisely because it asserts
    // liveness in the BOOLEAN form (`running: true`), so this exercises the half of the
    // rule a discriminator-only implementation would have missed — against the real
    // payload rather than a fixture.
    TranscriptWatcherTracker.resetForTest().setRunning(true);

    const { url, close } = await startTestServer();
    closeList.push(close);

    const res = await fetch(`${url}/api/health`);
    const body = (await res.json()) as Record<string, unknown>;

    const { undated, dated } = auditLivenessAssertions(body);

    // Message names the offender rather than asserting a bare length, so a future
    // regression reads as "principalChannel asserts state=running but..." not "1 !== 0".
    expect(describeUndatedLivenessAssertions(undated)).toBe("");
    expect(undated).toEqual([]);

    // NON-VACUITY (mem#704). `undated === []` is also what a check that examined
    // NOTHING returns, and every subsystem here could legitimately sit in a quiet
    // state (`disabled`, `unconfigured`) in which no liveness is asserted at all — so
    // the empty result above would be indistinguishable from the check being broken.
    // Asserting something WAS inspected is what gives the test above its meaning.
    expect(dated.length).toBeGreaterThan(0);
  });

  test("AT2: a fixture carrying mt#4183's shipped shape passes", () => {
    const findings = findUndatedLivenessAssertions({
      principalChannel: {
        state: "running",
        chatId: 12345,
        since: "2026-08-17T00:00:00.000Z",
        lastProgressAt: null,
      },
    });
    // `lastProgressAt: null` is deliberate — a loop that has reported nothing yet is
    // still DATABLE via `since`, and requiring non-null would fail every subsystem
    // during its first seconds.
    expect(findings).toEqual([]);
  });

  test("AT1 (negative control): the pre-mt#4183 principalChannel shape FAILS", () => {
    const findings = findUndatedLivenessAssertions({
      principalChannel: PRE_MT4183_PRINCIPAL_CHANNEL,
    });

    expect(findings).toEqual([{ field: "principalChannel", assertion: 'state="running"' }]);
    expect(describeUndatedLivenessAssertions(findings)).toContain("principalChannel");
  });

  test("AT3: a newly-invented sub-object is caught by NAME-INDEPENDENT shape", () => {
    // The point of the whole task. `widgetPump` exists nowhere in the payload, this
    // module, or the contract fixture — it is caught because of the SHAPE it has. An
    // allowlist of today's field names would return [] here, which is how the next
    // field ships exempt by omission.
    const findings = findUndatedLivenessAssertions({
      widgetPump: { state: "running", widgetsPumped: 42 },
    });

    expect(findings).toEqual([{ field: "widgetPump", assertion: 'state="running"' }]);
  });

  test("AT3: the boolean liveness form is caught too, not just the discriminator", () => {
    // mt#4186's planning finding: keying only on `state`/`mode`/`status` would have
    // exempted `transcriptWatcher`, which asserts liveness as `running: true`. That is
    // the same exempt-by-omission failure one level up — allowlisting a syntactic form
    // instead of a field name.
    const findings = findUndatedLivenessAssertions({
      newWatcher: { running: true, filesWatched: 3 },
    });

    expect(findings).toEqual([{ field: "newWatcher", assertion: "running=true" }]);
  });

  test("AT4: every declared exemption is exercised and NOT flagged", () => {
    // Each exemption gets a payload shaped to trip the check if it were in scope, so
    // the list is a tested claim rather than a comment.
    const exemptPayload: Record<string, unknown> = {
      status: "ok",
      service: "minsky-cockpit",
      version: "1.2.3",
      commit: "abc1234",
      processStartedAtMs: 1_700_000_000_000,
      uptimeSec: 42,
      db: "ok",
      consecutiveDegraded: 0,
    };

    // Every key above must be declared — otherwise this test drifts out of sync with
    // the module's own list and stops proving anything about it.
    expect(Object.keys(exemptPayload).sort()).toEqual(Object.keys(DECLARED_EXEMPTIONS).sort());
    expect(findUndatedLivenessAssertions(exemptPayload)).toEqual([]);
  });

  test("AT4: a non-affirmative state is not a liveness claim and owes no timestamp", () => {
    // `retrying` and `failed` are faults; `disabled`/`unconfigured` are healthy-quiet.
    // None claims the subsystem is currently working, so none needs dating to be honest.
    for (const state of ["retrying", "failed", "disabled", "unconfigured", "starting"]) {
      expect(findUndatedLivenessAssertions({ someSubsystem: { state } })).toEqual([]);
    }
  });

  test("AT4: monotonic counters are out of SCOPE, not exempted (SC1's explicit question)", () => {
    // SC1 asks whether a counter whose RISE is the signal should be exempt. The answer is
    // that the question does not arise: neither carries a liveness discriminator, so the
    // check never asks them for a timestamp. Asserted with their REAL shapes so this
    // stays true if either grows a field.
    const survivedExceptions = { lastAt: null, count: 0, distinctSignatures: 0 };
    const dbRecycle = { lastRecycleAt: null, recycleCount: 0 };

    expect(findUndatedLivenessAssertions({ survivedExceptions, dbRecycle })).toEqual([]);
    // And they are NOT on the exemption list — being off it is the point, since listing
    // them would imply a liveness claim was being forgiven.
    expect(Object.keys(DECLARED_EXEMPTIONS)).not.toContain("survivedExceptions");
    expect(Object.keys(DECLARED_EXEMPTIONS)).not.toContain("dbRecycle");
  });

  test("AT4: a non-liveness boolean does not drag a sub-object into scope", () => {
    // The boolean list is closed on purpose — "any boolean" would demand a timestamp
    // from flags that assert nothing about liveness.
    expect(findUndatedLivenessAssertions({ queue: { hasPendingWork: true, depth: 3 } })).toEqual(
      []
    );
  });

  // PR #3080 R1 — the reviewer's two non-blocking findings, pinned so neither reverts.
  test("R1: `enabled` is configuration, not liveness, and asserts nothing datable", () => {
    // A subsystem can be enabled and dead — that is this task's failure mode, not an
    // instance of health. Demanding a timestamp from a config flag would say nothing
    // about whether the thing runs.
    expect(findUndatedLivenessAssertions({ feature: { enabled: true, mode2: "x" } })).toEqual([]);
    // ...while the three real verdicts still fire.
    for (const key of ["running", "healthy", "ok"]) {
      expect(findUndatedLivenessAssertions({ sub: { [key]: true } })).toEqual([
        { field: "sub", assertion: `${key}=true` },
      ]);
    }
  });

  test("R1: an epoch-ms stamp dates an assertion as well as an ISO string", () => {
    // `processStartedAtMs` is the in-tree precedent for this spelling. Failing an honest
    // subsystem over its choice of units is the opposite of what the rule is for.
    expect(
      findUndatedLivenessAssertions({
        pump: { state: "running", lastAttemptAtMs: 1_700_000_000_000 },
      })
    ).toEqual([]);

    // But a non-finite number dates nothing — a broken computation must not satisfy the
    // rule just by occupying the field.
    expect(
      findUndatedLivenessAssertions({ pump: { state: "running", lastAttemptAtMs: NaN } })
    ).toEqual([{ field: "pump", assertion: 'state="running"' }]);
  });
});
