/**
 * mt#4322 SC3 / AT3 — golden contract for the MCP daemon's `GET /health`.
 *
 * Asserts `buildMcpHealthResponse` — the SAME function the route in
 * `start-command.ts` calls — against `contract/mcp-health-shape.json`. The
 * fixture is the contract; this file only reads it, so renaming a field in the
 * emitter fails here, and editing this file alone cannot make a broken emitter
 * pass.
 *
 * Sibling: `src/cockpit/health-contract.test.ts` for the cockpit's own route.
 */

import { describe, expect, test } from "bun:test";
import type { PersistenceHealthStatus } from "@minsky/domain/persistence/health";
// Static JSON import (resolveJsonModule) — the checked-in golden fixture IS the
// contract under test, so no fs access is needed (and the
// custom/no-real-fs-in-tests rule stays satisfied without an exception).
// Mirrors src/cockpit/health-contract.test.ts.
import healthShapeFixtureJson from "../../contract/mcp-health-shape.json";
import { buildMcpHealthResponse, MCP_HEALTH_SERVICE } from "./health-payload";

interface HealthContract {
  fields: Record<string, string>;
  requiredFields: string[];
  /** mt#4466 — emitted only when `persistence.mode === "connected"`. */
  conditionalFields: Record<string, string>;
  persistenceFields: Record<string, string>;
  dbCheckFields: Record<string, string>;
  sample: Record<string, unknown>;
}

function loadContract(): HealthContract {
  return healthShapeFixtureJson as unknown as HealthContract;
}

/** Map a JS runtime value to the coarse type vocabulary the fixture uses. */
function typeOf(value: unknown): string {
  if (value === null) return "object";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

const NOW = "2026-08-22T00:58:00.000Z";

const CONNECTED: PersistenceHealthStatus = { healthy: true, mode: "connected" };
const UNCONFIGURED: PersistenceHealthStatus = { healthy: true, mode: "unconfigured" };
const UNAVAILABLE: PersistenceHealthStatus = {
  healthy: false,
  mode: "unavailable",
  reason: "connect ECONNREFUSED",
};

/** mt#4466: a live probe that got through. */
const REACHABLE = {
  status: "ok" as const,
  check: { checkedAt: "2026-08-22T00:57:58.000Z", latencyMs: 12 },
};

/**
 * mt#4466: the pool wedge — the exact shape of mem#1120 R2.
 *
 * `checkedAt` is deliberately older than `timestamp`: in the never-settling
 * -query wedge nothing new finishes, so the stamp goes stale while the status
 * reads degraded. That pair is the diagnostic signal.
 */
const WEDGED = {
  status: "degraded" as const,
  check: { checkedAt: "2026-08-21T23:40:00.000Z", latencyMs: 41 },
};

describe("MCP /health golden contract (mt#4322)", () => {
  test("every contract field is present, with the declared type", () => {
    const contract = loadContract();
    const body = buildMcpHealthResponse(CONNECTED, NOW).body as unknown as Record<string, unknown>;

    for (const [field, declaredType] of Object.entries(contract.fields)) {
      expect(body).toHaveProperty(field);
      expect(typeOf(body[field])).toBe(declaredType);
    }
  });

  test("AT3 — removing `ready` from the emitted body fails this contract", () => {
    const contract = loadContract();
    const body = buildMcpHealthResponse(CONNECTED, NOW).body as unknown as Record<string, unknown>;

    // The assertion AT3 names, stated directly: `ready` is required, and a body
    // without it does not satisfy the contract. Simulating the removal here
    // (rather than editing the emitter) is what makes this a test of the
    // CONTRACT's strictness — the negative control in the PR body covers the
    // emitter side by actually deleting the field.
    expect(contract.requiredFields).toContain("ready");
    const withoutReady = { ...body };
    delete withoutReady.ready;
    const missing = contract.requiredFields.filter((f) => !(f in withoutReady));
    expect(missing).toEqual(["ready"]);
  });

  test("no contract field is silently dropped — the emitted key set matches", () => {
    const body = buildMcpHealthResponse(CONNECTED, NOW).body as unknown as Record<string, unknown>;
    const contract = loadContract();
    // Both directions: a field added to the emitter without updating the
    // fixture fails here too, so the fixture cannot quietly fall behind.
    expect(Object.keys(body).sort()).toEqual(Object.keys(contract.fields).sort());
  });

  test("persistence sub-object carries its declared fields", () => {
    const contract = loadContract();
    const { persistence } = buildMcpHealthResponse(CONNECTED, NOW).body;
    for (const [field, declaredType] of Object.entries(contract.persistenceFields)) {
      expect(typeOf((persistence as unknown as Record<string, unknown>)[field])).toBe(declaredType);
    }
  });

  test("service identity is the assertable key a probe can fail on (mt#3148)", () => {
    const { body } = buildMcpHealthResponse(CONNECTED, NOW);
    expect(body.service).toBe(MCP_HEALTH_SERVICE);
    expect(body.service).toBe("minsky-mcp");
    // `server` is retained alongside it, not replaced — mem#704's probe recipe
    // still cites it.
    expect(body.server).toBe("Minsky MCP Server");
  });
});

describe("MCP /health readiness vs liveness (mt#4297, pinned by mt#4322)", () => {
  test("connected is healthy AND ready", () => {
    const { statusCode, body } = buildMcpHealthResponse(CONNECTED, NOW);
    expect(statusCode).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.ready).toBe(true);
  });

  test("unconfigured stays 200 while ready is false — the bundle-boot-smoke invariant", () => {
    // This is the divergence the whole `ready` field exists for. A change that
    // makes this a 503 breaks the CI gate; one that makes `ready` true here
    // re-opens the 31-hour outage.
    const { statusCode, body } = buildMcpHealthResponse(UNCONFIGURED, NOW);
    expect(statusCode).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.ready).toBe(false);
  });

  test("unavailable is 503, unhealthy, not ready, and carries its reason", () => {
    const { statusCode, body } = buildMcpHealthResponse(UNAVAILABLE, NOW);
    expect(statusCode).toBe(503);
    expect(body.status).toBe("unhealthy");
    expect(body.ready).toBe(false);
    expect(body.persistence.reason).toBe("connect ECONNREFUSED");
  });

  test("reason is omitted rather than undefined when the assessment supplies none", () => {
    const { body } = buildMcpHealthResponse(CONNECTED, NOW);
    expect("reason" in body.persistence).toBe(false);
  });
});

describe("MCP /health live pool reachability (mt#4466)", () => {
  test("AT1 — a wedged pool reports degraded, where it previously reported ok", () => {
    // The acceptance test, stated directly. Identical `PersistenceHealthStatus`
    // in both calls: the ONLY difference is whether a query actually got
    // through. Before mt#4466 the second call was unrepresentable and this body
    // read `ok` / `ready: true` throughout a 50-minute outage.
    const healthy = buildMcpHealthResponse(CONNECTED, NOW, REACHABLE);
    expect(healthy.body.status).toBe("ok");
    expect(healthy.body.ready).toBe(true);

    const wedged = buildMcpHealthResponse(CONNECTED, NOW, WEDGED);
    expect(wedged.body.status).toBe("degraded");
    expect(wedged.body.ready).toBe(false);
  });

  test("a wedged pool stays HTTP 200 — liveness is not readiness", () => {
    // Pinned deliberately, and NOT an oversight. A 503 would be classified
    // `foreign` by classifyDaemonProbe (it tests http-error before identity),
    // which for a wedged-but-ours daemon is a misdiagnosis with a destructive
    // remedy. `ready: false` already yields the correct `not-ready` there.
    expect(buildMcpHealthResponse(CONNECTED, NOW, WEDGED).statusCode).toBe(200);
  });

  test("db and dbCheck carry the declared conditional types", () => {
    const contract = loadContract();
    const body = buildMcpHealthResponse(CONNECTED, NOW, WEDGED).body as unknown as Record<
      string,
      unknown
    >;
    for (const [field, declaredType] of Object.entries(contract.conditionalFields)) {
      expect(body).toHaveProperty(field);
      expect(typeOf(body[field])).toBe(declaredType);
    }
    for (const [field, declaredType] of Object.entries(contract.dbCheckFields)) {
      expect(typeOf((body.dbCheck as Record<string, unknown>)[field])).toBe(declaredType);
    }
  });

  test("the emitted key set is base + conditional, both directions", () => {
    const contract = loadContract();
    const body = buildMcpHealthResponse(CONNECTED, NOW, WEDGED).body as unknown as Record<
      string,
      unknown
    >;
    const expected = [
      ...Object.keys(contract.fields),
      ...Object.keys(contract.conditionalFields),
    ].sort();
    expect(Object.keys(body).sort()).toEqual(expected);
  });

  test("unconfigured emits NO db fields, even when a probe result is supplied", () => {
    // The bundle-boot-smoke invariant, extended: a bundle booted with no
    // Postgres must keep emitting exactly what it emitted before mt#4466. A
    // `db: "unreachable"` here would read as an alarm for the expected boot.
    const { statusCode, body } = buildMcpHealthResponse(UNCONFIGURED, NOW, WEDGED);
    expect(statusCode).toBe(200);
    expect(body.status).toBe("ok");
    expect("db" in body).toBe(false);
    expect("dbCheck" in body).toBe(false);
  });

  test("unavailable emits no db fields and keeps its 503", () => {
    // Initialization already failed; there is no pool to have probed, and
    // `unavailable` is a strictly worse state than `degraded` — it must not be
    // softened by a probe result that cannot apply.
    const { statusCode, body } = buildMcpHealthResponse(UNAVAILABLE, NOW, WEDGED);
    expect(statusCode).toBe(503);
    expect(body.status).toBe("unhealthy");
    expect("db" in body).toBe(false);
  });

  test("omitting the probe entirely preserves pre-mt#4466 behaviour exactly", () => {
    // Back-compat for any caller that has not been threaded through yet: no
    // probe means no claim, not a false alarm.
    const { statusCode, body } = buildMcpHealthResponse(CONNECTED, NOW);
    expect(statusCode).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.ready).toBe(true);
    expect("db" in body).toBe(false);
  });

  test("a stale checkedAt beside degraded is preserved — the wedge signature", () => {
    // The never-settle wedge does not refresh `checkedAt`; the emitter must pass
    // that through rather than restamping it, or the single most diagnostic
    // pair in this body is destroyed on the way out.
    const { body } = buildMcpHealthResponse(CONNECTED, NOW, WEDGED);
    expect(body.dbCheck?.checkedAt).toBe("2026-08-21T23:40:00.000Z");
    expect(body.timestamp).toBe(NOW);
    expect(body.dbCheck?.checkedAt).not.toBe(body.timestamp);
  });
});
