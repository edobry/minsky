/**
 * mt#3963 — the post-deploy health monitor must be able to RETIRE a P0, and
 * must not retire one it cannot see recover.
 *
 * The production shape these tests encode is the four P0s open on 2026-08-11 —
 * #2362 (reviewer digest-lag, 14 days), #1775 / #1774 / #1718 (health-down, up
 * to 54 days) — every one of them for a condition run 31512527726 reported OK.
 */

import { describe, expect, test } from "bun:test";

import {
  P0_RECOVERY_MIN_SUSTAINED_INTERVAL_MS,
  decideP0Resolution,
  formatP0RecoveryMarker,
  isMonitorAuthoredP0,
  observedRecoveredClasses,
  parseP0RecoveryMarker,
  stripP0RecoveryMarker,
  withP0RecoveryMarker,
} from "./monitor-p0-resolution";
import type { AlertClass, CheckSummary, ServiceCheckSummary } from "./monitor-verdict";

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

const summary = (overrides: Partial<ServiceCheckSummary> = {}): ServiceCheckSummary => ({
  service: "reviewer",
  deploy: ran(),
  health: ran(),
  digest: ran(),
  ...overrides,
});

/** The body of P0 #1718, trimmed — a real monitor-authored issue. */
const MONITOR_AUTHORED_BODY = [
  "## P0: [P0] reviewer: Health check DOWN",
  "",
  "**Detected at:** 2026-06-18T02:21:13.341Z",
  "",
  "---",
  "*Auto-opened by [post-deploy-health-monitor](.github/workflows/post-deploy-health-monitor.yml) (mt#1302).*",
  "*Close this issue when the service is confirmed healthy.*",
].join("\n");

describe("observedRecoveredClasses", () => {
  // AT1 (recovery half) — a healthy observation for a service.
  test("AT1: a fully passing service reports every class recovered", () => {
    const expected: AlertClass[] = ["check-failed", "deploy-failed", "digest-lag", "health-down"];

    expect(observedRecoveredClasses(summary()).sort()).toEqual(expected.sort());
  });

  // AT1 (still-failing half) — the class whose condition persists is NOT recovered.
  test("AT1: a still-failing health probe does not report health-down recovered", () => {
    const recovered = observedRecoveredClasses(summary({ health: ran(true) }));

    expect(recovered).not.toContain("health-down");
    // The other classes are independent — a down service can still retire a
    // resolved digest-lag P0.
    expect(recovered).toContain("digest-lag");
  });

  test("a digest lag that is present but not yet sustained is NOT a recovery", () => {
    // The monitor raises no digest-lag alert on a first observation, which is
    // precisely the state in which reading "no alert" as "recovered" would
    // close a P0 against a service that is still lagging.
    expect(observedRecoveredClasses(summary({ digest: ran(true) }))).not.toContain("digest-lag");
  });

  // The mt#3921 rule, one tier up: a check that could not run has observed
  // nothing, so it is not evidence the condition cleared.
  test("a check that could not run reports neither its class nor check-failed recovered", () => {
    const recovered = observedRecoveredClasses(
      summary({ digest: couldNotRun("Railway GraphQL errors: Not Authorized") })
    );

    expect(recovered).not.toContain("digest-lag");
    expect(recovered).not.toContain("check-failed");
    expect(recovered).toContain("health-down");
  });

  test("a not-applicable check is silence about its class, but does not block check-failed", () => {
    const recovered = observedRecoveredClasses(
      summary({
        service: "cockpit",
        digest: notApplicable("repo-source service — no configured image to compare"),
      })
    );

    expect(recovered).not.toContain("digest-lag");
    expect(recovered).toContain("check-failed");
  });
});

describe("decideP0Resolution", () => {
  const nowMs = Date.parse("2026-08-11T17:00:00.000Z");

  test("a first recovered observation marks, it does not close", () => {
    const decision = decideP0Resolution({ recoveryFirstObservedAtIso: null, nowMs });

    expect(decision.action).toBe("mark");
  });

  test("a recovery shorter than the sustained interval waits", () => {
    const decision = decideP0Resolution({
      recoveryFirstObservedAtIso: new Date(nowMs - 60_000).toISOString(),
      nowMs,
    });

    expect(decision.action).toBe("wait");
  });

  test("a recovery at or past the sustained interval closes", () => {
    const decision = decideP0Resolution({
      recoveryFirstObservedAtIso: new Date(
        nowMs - P0_RECOVERY_MIN_SUSTAINED_INTERVAL_MS
      ).toISOString(),
      nowMs,
    });

    expect(decision.action).toBe("close");
    expect(decision.note).toContain("threshold");
  });

  test("a marker timestamped in the future waits rather than closing", () => {
    const decision = decideP0Resolution({
      recoveryFirstObservedAtIso: new Date(nowMs + 60 * 60_000).toISOString(),
      nowMs,
    });

    expect(decision.action).toBe("wait");
  });

  test("the sustained interval sits under the workflow's 10-minute cron cadence", () => {
    // Otherwise a recovery observed on one scheduled tick would never satisfy
    // the threshold on the next one, and P0s would take three ticks to retire.
    expect(P0_RECOVERY_MIN_SUSTAINED_INTERVAL_MS).toBeLessThan(10 * 60 * 1000);
  });
});

describe("recovery marker", () => {
  test("round-trips through the issue body", () => {
    const iso = "2026-08-11T17:00:00.000Z";
    const body = withP0RecoveryMarker(MONITOR_AUTHORED_BODY, iso);

    expect(body).toContain(formatP0RecoveryMarker(iso));
    expect(parseP0RecoveryMarker(body)).toBe(iso);
  });

  test("an unmarked body parses as no observation", () => {
    expect(parseP0RecoveryMarker(MONITOR_AUTHORED_BODY)).toBeNull();
    expect(parseP0RecoveryMarker(null)).toBeNull();
  });

  test("an unparseable marker fails closed — read as no observation, not as an old one", () => {
    const body = `${MONITOR_AUTHORED_BODY}\n\nP0_RECOVERY_FIRST_OBSERVED_AT: not-a-date\n`;

    expect(parseP0RecoveryMarker(body)).toBeNull();
  });

  test("re-marking replaces the previous marker rather than stacking a second one", () => {
    const first = withP0RecoveryMarker(MONITOR_AUTHORED_BODY, "2026-08-11T17:00:00.000Z");
    const second = withP0RecoveryMarker(first, "2026-08-11T18:00:00.000Z");

    expect(second.match(/P0_RECOVERY_FIRST_OBSERVED_AT:/g)).toHaveLength(1);
    expect(parseP0RecoveryMarker(second)).toBe("2026-08-11T18:00:00.000Z");
  });

  // The one non-obvious correctness requirement: a service that recovers, is
  // marked, then breaks again inside the window must not be closed by a later
  // run reading a stale marker.
  test("stripping the marker restores an unmarked body, so a re-broken service starts over", () => {
    const marked = withP0RecoveryMarker(MONITOR_AUTHORED_BODY, "2026-08-11T17:00:00.000Z");
    const stripped = stripP0RecoveryMarker(marked);

    expect(parseP0RecoveryMarker(stripped)).toBeNull();
    expect(stripped).toContain("Auto-opened by [post-deploy-health-monitor]");
    expect(
      decideP0Resolution({
        recoveryFirstObservedAtIso: parseP0RecoveryMarker(stripped),
        nowMs: Date.parse("2026-08-11T23:00:00.000Z"),
      }).action
    ).toBe("mark");
  });
});

describe("isMonitorAuthoredP0", () => {
  test("a monitor-authored P0 is resolvable", () => {
    expect(isMonitorAuthoredP0(MONITOR_AUTHORED_BODY)).toBe(true);
  });

  // AT2 — an issue carrying the P0 label but not the monitor's marker is left
  // untouched.
  test("AT2: a hand-filed P0 with no monitor signature is not resolvable", () => {
    const handFiled = [
      "## P0: [P0] reviewer: Health check DOWN",
      "",
      "Filed by hand during the incident call. Do not auto-close.",
    ].join("\n");

    expect(isMonitorAuthoredP0(handFiled)).toBe(false);
    expect(isMonitorAuthoredP0(null)).toBe(false);
  });
});
