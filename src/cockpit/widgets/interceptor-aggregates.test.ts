/**
 * Widget-behavior tests for interceptor-aggregates (mt#4009).
 *
 * The catalog path reads only the in-process snapshot (seeded/reset via the
 * cache module's test seams); the detail path resolves a real DB, which the
 * mt#3254 test-environment guard refuses under `bun test` — the widget must
 * surface that as a DEGRADED result, not throw.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { interceptorAggregatesWidget } from "./interceptor-aggregates";
import {
  resetInterceptorAggregatesCacheForTests,
  setInterceptorAggregatesCacheForTests,
} from "../interceptor-aggregates-cache";
import type { InterceptorAggregatesSnapshot } from "@minsky/domain/guard-events/aggregates";
import { SNAPSHOT_SOURCES } from "@minsky/domain/guard-events/aggregates";

const WIDGET_ID = "interceptor-aggregates";
const SAMPLE_GUARD = "wall-of-text-detector";

afterEach(() => {
  resetInterceptorAggregatesCacheForTests();
});

function snapshotFixture(): InterceptorAggregatesSnapshot {
  return {
    computedAt: "2026-08-12T20:00:00.000Z",
    windowDays: 7,
    population: 1,
    rows: [
      {
        guardName: SAMPLE_GUARD,
        fireLog: {
          window: {
            days: 7,
            fires: 3,
            byDecision: { allow: 2, warn: 1, deny: 0, other: 0 },
            overrides: { total: 0, byEnvVar: {} },
            duration: null,
          },
          lifetime: { totalFires: 3594, firstFireAt: null, lastFireAt: null },
        },
        canary: { state: "passing" },
        health: null,
        calibration: null,
        registry: { registered: true, stratum: "registry" },
      },
    ],
    declaredOnlyRows: [],
    calibrationReviewDue: [],
    sources: SNAPSHOT_SOURCES,
    sourceFailures: [],
    refreshDurationMs: 2500,
  };
}

describe("interceptorAggregatesWidget", () => {
  test("catalog path reports pending before the first refresh completes", async () => {
    resetInterceptorAggregatesCacheForTests();
    const result = await interceptorAggregatesWidget.fetch({ id: WIDGET_ID });
    expect(result.state).toBe("ok");
    const payload = (result as { payload: { status: string; snapshot: unknown } }).payload;
    expect(payload.status).toBe("pending");
    expect(payload.snapshot).toBeNull();
  });

  test("catalog path serves the seeded snapshot without querying anything", async () => {
    setInterceptorAggregatesCacheForTests(snapshotFixture());
    const result = await interceptorAggregatesWidget.fetch({ id: WIDGET_ID });
    expect(result.state).toBe("ok");
    const payload = (
      result as { payload: { status: string; snapshot: InterceptorAggregatesSnapshot } }
    ).payload;
    expect(payload.status).toBe("ready");
    expect(payload.snapshot.population).toBe(1);
    expect(payload.snapshot.rows[0]?.guardName).toBe(SAMPLE_GUARD);
  });

  test("detail path degrades (not throws) when no database is resolvable", async () => {
    // Under `bun test`, resolving the real configured DB is refused by the
    // mt#3254 guard; the widget must convert that into a degraded result.
    const result = await interceptorAggregatesWidget.fetch({
      id: WIDGET_ID,
      query: { guard: SAMPLE_GUARD },
    });
    expect(result.state).toBe("degraded");
    expect((result as { reason: string }).reason).toContain(WIDGET_ID);
  });
});
