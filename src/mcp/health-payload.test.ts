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
import type { ReadinessResult } from "@minsky/domain/persistence/readiness-probe";
// Static JSON import (resolveJsonModule) — the checked-in golden fixture IS the
// contract under test, so no fs access is needed (and the
// custom/no-real-fs-in-tests rule stays satisfied without an exception).
// Mirrors src/cockpit/health-contract.test.ts.
import healthShapeFixtureJson from "../../contract/mcp-health-shape.json";
import { buildMcpHealthResponse, MCP_HEALTH_SERVICE } from "./health-payload";

interface HealthContract {
  fields: Record<string, string>;
  requiredFields: string[];
  persistenceFields: Record<string, string>;
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
/** The `unavailable` assessment's own reason, asserted in more than one place. */
const UNAVAILABLE_REASON = "connect ECONNREFUSED";

const UNAVAILABLE: PersistenceHealthStatus = {
  healthy: false,
  mode: "unavailable",
  reason: UNAVAILABLE_REASON,
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
    expect(body.persistence.reason).toBe(UNAVAILABLE_REASON);
  });

  test("reason is omitted rather than undefined when the assessment supplies none", () => {
    const { body } = buildMcpHealthResponse(CONNECTED, NOW);
    expect("reason" in body.persistence).toBe(false);
  });
});

describe("readiness is an observation, not a type declaration (mt#4471)", () => {
  const PROBE_OK: ReadinessResult = { ok: true, checkedAt: NOW, durationMs: 3 };
  const PROBE_TIMED_OUT: ReadinessResult = {
    ok: false,
    reason:
      "persistence round-trip did not complete within 1500ms — the connection pool is not serving queries",
    checkedAt: NOW,
    durationMs: 1500,
  };

  test("THE REGRESSION: a connected provider whose pool cannot serve is NOT ready", () => {
    // The 2026-08-23 outage in one assertion. `mode` is "connected" — the
    // provider object is real and SQL-capable — and every DB-backed call is
    // hanging. Before mt#4471 `ready` was `mode === "connected"` alone, so this
    // exact input produced `ready: true`, which /health answered twice while
    // three conversations were dead.
    const { body } = buildMcpHealthResponse(CONNECTED, NOW, PROBE_TIMED_OUT);

    expect(body.ready).toBe(false);
    expect(body.persistence.mode).toBe("connected");
    expect(body.persistence.reason).toContain("connection pool");
  });

  test("a connected provider that round-trips IS ready", () => {
    const { body } = buildMcpHealthResponse(CONNECTED, NOW, PROBE_OK);
    expect(body.ready).toBe(true);
    expect("reason" in body.persistence).toBe(false);
  });

  test("a failing probe does NOT flip the status code — liveness stays separate", () => {
    // The status code answers "did the process boot?". A saturated pool is a
    // readiness fact, and collapsing the two would either brick the CI smoke
    // gate or re-introduce the incident `ready` exists to make visible.
    const { statusCode, body } = buildMcpHealthResponse(CONNECTED, NOW, PROBE_TIMED_OUT);
    expect(statusCode).toBe(200);
    expect(body.status).toBe("ok");
  });

  test("the assessment's own reason outranks the probe's", () => {
    // `unavailable` already knows why it is broken, and that is the more
    // specific diagnosis; the probe's generic explanation must not shadow it.
    const { body } = buildMcpHealthResponse(UNAVAILABLE, NOW, PROBE_TIMED_OUT);
    expect(body.persistence.reason).toBe(UNAVAILABLE_REASON);
  });

  test("unconfigured stays 200-and-not-ready with no probe — the CI smoke gate's state", () => {
    const { statusCode, body } = buildMcpHealthResponse(UNCONFIGURED, NOW, undefined);
    expect(statusCode).toBe(200);
    expect(body.ready).toBe(false);
  });

  test("omitting the probe preserves pre-mt#4471 behaviour for non-route callers", () => {
    const { body } = buildMcpHealthResponse(CONNECTED, NOW);
    expect(body.ready).toBe(true);
  });
});
