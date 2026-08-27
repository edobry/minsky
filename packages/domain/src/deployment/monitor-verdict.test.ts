/**
 * mt#3921 — the post-deploy health monitor must not score an unrunnable check
 * as a passing one.
 *
 * The production shape these tests encode is run 31392266054 (2026-08-10):
 * every service logged `Railway GraphQL errors: Not Authorized`, the digest
 * check was skipped for want of that data, and each service still printed
 * `Status: HEALTHY` with `Total alerts fired: 0`.
 *
 * mt#1495 added check (d) — DB-pool recovery counters. Every fixture below
 * carries `recovery: NO_COUNTERS`, which is what all five services report
 * today: only the cockpit publishes `dbRecycle` at all, and even there the
 * reading is `not-applicable` until a recycle has actually happened. So these
 * tests keep asserting exactly what they asserted before, and check (d)'s own
 * behaviour is covered in `monitor-recovery-alarm.test.ts`.
 */

import { describe, expect, test } from "bun:test";

import { scoreService, type CheckSummary, type ServiceCheckSummary } from "./monitor-verdict";

/** The verbatim errors run 31392266054 logged, for every service. */
const NOT_AUTHORIZED = "Railway GraphQL errors: Not Authorized";
const NO_DEPLOY_DATA = "No Railway deployment data available — cannot compare digests";

const ran = (problem = false): CheckSummary => ({ outcome: "ok", detail: null, problem });

const notApplicable = (detail: string): CheckSummary => ({
  outcome: "not-applicable",
  detail,
  problem: false,
});

const couldNotRun = (detail: string): CheckSummary => ({
  outcome: "failed",
  detail,
  problem: false,
});

/** Check (d) for a service that publishes no `dbRecycle` — i.e. all of them but the cockpit. */
const NO_COUNTERS = notApplicable("service publishes no dbRecycle counters");

/** A repo-source service (cockpit, site): no configured image, so no digest check. */
const healthyRepoSourceService = (): ServiceCheckSummary => ({
  service: "cockpit",
  deploy: ran(),
  health: ran(),
  digest: notApplicable("repo-source service — no configured image to compare"),
  recovery: NO_COUNTERS,
});

describe("scoreService", () => {
  test("a fully passing service is HEALTHY with no alerts", () => {
    const score = scoreService(healthyRepoSourceService(), false);

    expect(score.verdict).toBe("HEALTHY");
    expect(score.alerts).toHaveLength(0);
  });

  // AT1 — the exact case that shipped.
  test("AT1: a service whose Railway check errored is not HEALTHY and raises an alert", () => {
    const score = scoreService(
      {
        service: "minsky-mcp",
        deploy: couldNotRun(NOT_AUTHORIZED),
        health: ran(),
        digest: couldNotRun(NO_DEPLOY_DATA),
        recovery: NO_COUNTERS,
      },
      false
    );

    expect(score.verdict).not.toBe("HEALTHY");
    expect(score.alerts.length).toBeGreaterThanOrEqual(1);
    expect(score.alerts.map((a) => a.class)).toContain("check-failed");
  });

  test("AT1: a passing /health probe does not rescue a service whose other checks could not run", () => {
    // The production log printed `Health: HTTP 200 — OK` on every one of these
    // runs. Two of three checks blind is not "healthy on the strength of the
    // third."
    const score = scoreService(
      {
        service: "reviewer",
        deploy: couldNotRun(NOT_AUTHORIZED),
        health: ran(),
        digest: couldNotRun(NO_DEPLOY_DATA),
        recovery: NO_COUNTERS,
      },
      false
    );

    expect(score.verdict).toBe("DEGRADED");
    expect(score.alerts[0]?.reason).toContain("UNKNOWN");
  });

  test("several unrunnable checks raise ONE aggregated alert naming each of them", () => {
    // The issue title de-dupes on (service, class), so one alert per failed
    // check would collide into a single issue and lose two of the three.
    const score = scoreService(
      {
        service: "minsky-mcp",
        deploy: couldNotRun(NOT_AUTHORIZED),
        health: couldNotRun("fetch timed out after 10000ms"),
        digest: couldNotRun(NO_DEPLOY_DATA),
        recovery: NO_COUNTERS,
      },
      false
    );

    expect(score.alerts).toHaveLength(1);
    expect(score.alerts[0]?.class).toBe("check-failed");
    expect(score.alerts[0]?.reason).toContain("Railway deploy status");
    expect(score.alerts[0]?.reason).toContain("HTTP /health probe");
    expect(score.alerts[0]?.reason).toContain("deployed-image digest");
  });

  // AT2 — the two kinds of skip must score differently.
  test("AT2: a not-applicable check does not alert, while an unrunnable one does", () => {
    const notApplicableScore = scoreService(healthyRepoSourceService(), false);

    expect(notApplicableScore.verdict).toBe("HEALTHY");
    expect(notApplicableScore.alerts).toHaveLength(0);

    const dependencyFailureScore = scoreService(
      {
        ...healthyRepoSourceService(),
        digest: couldNotRun(NO_DEPLOY_DATA),
      },
      false
    );

    expect(dependencyFailureScore.verdict).toBe("DEGRADED");
    expect(dependencyFailureScore.alerts.map((a) => a.class)).toEqual(["check-failed"]);
  });

  test("AT2: a service with no health endpoint is not scored as unhealthy for lacking one", () => {
    const score = scoreService(
      {
        service: "minsky-ops",
        deploy: ran(),
        health: notApplicable("no healthUrl configured"),
        digest: ran(),
        recovery: NO_COUNTERS,
      },
      false
    );

    expect(score.verdict).toBe("HEALTHY");
  });

  test("a check that ran and found a real problem alerts under its own class", () => {
    const score = scoreService(
      {
        service: "reviewer",
        deploy: { outcome: "ok", detail: "deployment CRASHED", problem: true },
        health: { outcome: "ok", detail: "HTTP 503", problem: true },
        digest: ran(),
        recovery: NO_COUNTERS,
      },
      false
    );

    expect(score.verdict).toBe("DEGRADED");
    expect(score.alerts.map((a) => a.class)).toEqual(["deploy-failed", "health-down"]);
  });

  test("a digest lag alerts only once the cross-run tracker says it is sustained", () => {
    const lagging: ServiceCheckSummary = {
      service: "minsky-mcp",
      deploy: ran(),
      health: ran(),
      digest: { outcome: "ok", detail: "deployed sha256:aaa, registry sha256:bbb", problem: true },
      recovery: NO_COUNTERS,
    };

    // A single observation is the normal build-push-redeploy window (mt#3284).
    expect(scoreService(lagging, false).verdict).toBe("HEALTHY");

    const sustained = scoreService(lagging, true);
    expect(sustained.verdict).toBe("DEGRADED");
    expect(sustained.alerts.map((a) => a.class)).toEqual(["digest-lag"]);
  });

  test("a `problem` flag on a check that could not run is ignored", () => {
    // A check that observed nothing cannot have found a problem; the outcome,
    // not the stale flag, decides.
    const score = scoreService(
      {
        service: "site",
        deploy: { outcome: "failed", detail: NOT_AUTHORIZED, problem: true },
        health: ran(),
        digest: notApplicable("repo-source service — no configured image to compare"),
        recovery: NO_COUNTERS,
      },
      false
    );

    expect(score.alerts.map((a) => a.class)).toEqual(["check-failed"]);
  });

  // mt#1495 — check (d)'s contribution to the verdict. The reading-level cases
  // live in monitor-recovery-alarm.test.ts; these cover the wiring.
  test("mt#1495: an abandoned-close reading alerts under recovery-degraded, not health-down", () => {
    const score = scoreService(
      {
        ...healthyRepoSourceService(),
        recovery: { outcome: "ok", detail: "3 of 12 pool recycles ABANDONED", problem: true },
      },
      false
    );

    expect(score.verdict).toBe("DEGRADED");
    // Its own class: the service is answering 200, so `health-down` would send
    // an operator to look at the wrong thing.
    expect(score.alerts.map((a) => a.class)).toEqual(["recovery-degraded"]);
    expect(score.alerts[0]?.reason).toContain("ABANDONED");
  });

  test("mt#1495: an unrunnable recovery check makes the service DEGRADED, not HEALTHY", () => {
    const score = scoreService(
      {
        ...healthyRepoSourceService(),
        recovery: couldNotRun("dbRecycle is present but is not an object"),
      },
      false
    );

    expect(score.verdict).toBe("DEGRADED");
    expect(score.alerts.map((a) => a.class)).toEqual(["check-failed"]);
    expect(score.alerts[0]?.reason).toContain("DB-pool recovery counters");
  });
});
