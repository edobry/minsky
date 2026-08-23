/**
 * Tests for the daemon control surface's decision logic (mt#4466).
 *
 * Pure functions over a snapshot, so the states that are hardest to produce for
 * real — a wedged pool, a foreign port holder, a stale discovery record — are
 * the cheapest ones to assert here. Two of them are refusals, and those matter
 * most: `planRestart` must never authorize killing a process it has not
 * identified.
 */

import { describe, expect, test } from "bun:test";
import { describeDaemon, planRestart, SHARED_FATE_NOTE, type DaemonSnapshot } from "./control";
import type { LocalDaemonDiscoveryRecord } from "./local-daemon";

const NOW = Date.parse("2026-08-23T18:30:00.000Z");

const RECORD: LocalDaemonDiscoveryRecord = {
  host: "127.0.0.1",
  port: 48765,
  pid: 32055,
  startedAt: "2026-08-23T18:00:00.000Z",
};

/** A health body from a daemon whose pool is answering. */
function healthyBody(): DaemonSnapshot {
  return {
    record: RECORD,
    probe: {
      kind: "body",
      body: {
        service: "minsky-mcp",
        status: "ok",
        ready: true,
        persistence: { mode: "connected" },
        db: "ok",
        dbCheck: { checkedAt: "2026-08-23T18:29:58.000Z", latencyMs: 9 },
      },
    },
  };
}

/** The mem#1120 R2 shape: alive, identified, connected — and not answering. */
function wedgedBody(): DaemonSnapshot {
  return {
    record: RECORD,
    probe: {
      kind: "body",
      body: {
        service: "minsky-mcp",
        status: "degraded",
        ready: false,
        persistence: { mode: "connected" },
        db: "degraded",
        dbCheck: { checkedAt: "2026-08-23T17:35:12.000Z", latencyMs: 41 },
      },
    },
  };
}

describe("describeDaemon", () => {
  test("no discovery record is distinct from an absent daemon", () => {
    // Different causes, different remedies: nothing ever started one here,
    // versus one started and stopped answering.
    const report = describeDaemon({ record: null, probe: null }, NOW);

    expect(report.state).toBe("no-record");
    expect(report.pid).toBeNull();
    expect(report.remedy).toContain("minsky setup local-http");
  });

  test("reports a healthy daemon with its uptime and pool state", () => {
    const report = describeDaemon(healthyBody(), NOW);

    expect(report.state).toBe("running");
    expect(report.pid).toBe(32055);
    expect(report.port).toBe(48765);
    expect(report.uptimeMs).toBe(30 * 60 * 1000);
    expect(report.db).toBe("ok");
    expect(report.ready).toBe(true);
    // Nothing is wrong, so nothing is prescribed.
    expect(report.remedy).toBeNull();
  });

  test("a wedged pool gets its own branch, and the remedy names the restart", () => {
    // SC3's floor: the surface must say what to do, so the next agent does not
    // spend an hour deriving the process topology.
    const report = describeDaemon(wedgedBody(), NOW);

    expect(report.state).toBe("not-ready");
    expect(report.db).toBe("degraded");
    expect(report.ready).toBe(false);
    expect(report.dbCheckedAt).toBe("2026-08-23T17:35:12.000Z");
    expect(report.remedy).toContain("minsky mcp restart --execute");
    // The CLI-vs-MCP discriminator that settled the real incident in one call.
    expect(report.remedy).toContain("CLI");
  });

  test("the wedge detail carries the stale check time, not the poll time", () => {
    // A stale `checkedAt` beside a degraded `db` IS the never-settle signature.
    // Reporting the poll time instead would erase the only evidence of it.
    const report = describeDaemon(wedgedBody(), NOW);
    expect(report.detail).toContain("2026-08-23T17:35:12.000Z");
  });

  test("an unreachable probe reports absent and points at the tray", () => {
    const report = describeDaemon(
      { record: RECORD, probe: { kind: "unreachable", detail: "ECONNREFUSED" } },
      NOW
    );

    expect(report.state).toBe("absent");
    expect(report.remedy).toContain("Cockpit");
  });

  test("a foreign port holder is reported as foreign, and never as ours", () => {
    const report = describeDaemon(
      {
        record: RECORD,
        probe: { kind: "body", body: { service: "minsky-cockpit", status: "ok" } },
      },
      NOW
    );

    expect(report.state).toBe("foreign");
    expect(report.remedy).toContain("do NOT kill it");
  });

  test("a body with no db field still reports, without inventing one", () => {
    // A daemon built before mt#4466 publishes no `db`. Absence must read as
    // "not measured", never as a value.
    const report = describeDaemon(
      {
        record: RECORD,
        probe: {
          kind: "body",
          body: { service: "minsky-mcp", status: "ok", ready: true },
        },
      },
      NOW
    );

    expect(report.state).toBe("running");
    expect(report.db).toBeNull();
    expect(report.dbCheckedAt).toBeNull();
  });

  test("an unparseable startedAt yields a null uptime rather than NaN", () => {
    const report = describeDaemon(
      { ...healthyBody(), record: { ...RECORD, startedAt: "not-a-date" } },
      NOW
    );

    expect(report.uptimeMs).toBeNull();
  });
});

describe("planRestart", () => {
  test("refuses when there is no record", () => {
    const plan = planRestart(describeDaemon({ record: null, probe: null }, NOW));

    expect(plan.action).toBe("refuse");
  });

  test("REFUSES to kill a foreign port holder", () => {
    // The load-bearing refusal. Killing here would apply a destructive remedy
    // to the mt#3142 misdiagnosis (a different application on the port).
    const report = describeDaemon(
      {
        record: RECORD,
        probe: { kind: "body", body: { service: "minsky-cockpit", status: "ok" } },
      },
      NOW
    );
    const plan = planRestart(report);

    expect(plan.action).toBe("refuse");
    if (plan.action === "refuse") {
      expect(plan.reason).toContain("Refusing to kill");
    }
  });

  test("refuses when nothing is answering — there is nothing to restart", () => {
    const report = describeDaemon(
      { record: RECORD, probe: { kind: "unreachable", detail: "ECONNREFUSED" } },
      NOW
    );

    expect(planRestart(report).action).toBe("refuse");
  });

  test("authorizes a restart of a wedged daemon, naming why", () => {
    const plan = planRestart(describeDaemon(wedgedBody(), NOW));

    expect(plan.action).toBe("restart");
    if (plan.action === "restart") {
      expect(plan.pid).toBe(32055);
      expect(plan.rationale).toContain("cannot serve DB-backed work");
    }
  });

  test("authorizes a restart of a healthy daemon on explicit request", () => {
    const plan = planRestart(describeDaemon(healthyBody(), NOW));

    expect(plan.action).toBe("restart");
    if (plan.action === "restart") {
      expect(plan.rationale).toContain("explicit request");
    }
  });
});

describe("SHARED_FATE_NOTE", () => {
  test("cites the measurement rather than warning vaguely", () => {
    // ADR-038 §Q6 ACCEPTED shared fate on evidence; the preview should carry
    // that evidence, not a scary adjective.
    expect(SHARED_FATE_NOTE).toContain("ADR-038");
    expect(SHARED_FATE_NOTE).toContain("8-14ms");
  });

  test("states the cost that is NOT covered by the retry window", () => {
    // The shim's 15s retry covers calls that land during the cold start. Calls
    // already in flight are the real loss, and saying so is what makes this a
    // citation instead of reassurance.
    expect(SHARED_FATE_NOTE).toContain("already in flight");
  });
});
