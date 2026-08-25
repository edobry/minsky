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
  formatP0SubjectMarker,
  isMonitorAuthoredP0,
  matchesP0Subject,
  observedRecoveredClasses,
  parseP0RecoveryMarker,
  parseP0SubjectMarker,
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
  recovery: ran(),
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
    const expected: AlertClass[] = [
      "check-failed",
      "deploy-failed",
      "digest-lag",
      "health-down",
      "recovery-degraded",
    ];

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
  test("stripping a marker an operator moved inline leaves no double blank line behind", () => {
    const inline = ["## P0", "", formatP0RecoveryMarker("2026-08-11T17:00:00.000Z"), "", "tail"]
      .join("\n")
      .concat("\n");

    expect(stripP0RecoveryMarker(inline)).toBe("## P0\n\ntail\n");
  });

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

describe("matchesP0Subject (PR #2845 R1 — a retitled P0 must still be found)", () => {
  const subject = {
    service: "reviewer",
    failureClass: "health-down" as AlertClass,
    canonicalTitle: "[P0] reviewer: Health check DOWN",
  };

  test("an untouched pre-marker P0 matches on its canonical title", () => {
    expect(
      matchesP0Subject({ title: subject.canonicalTitle, body: MONITOR_AUTHORED_BODY }, subject)
    ).toBe(true);
  });

  // The blocking finding: an operator adds context to the title mid-incident.
  // Under exact-title equality this issue was never found again, so it stayed
  // open forever — the exact defect this module exists to end.
  test("a pre-marker P0 retitled with operator context still matches", () => {
    const retitled = {
      title: "[P0] reviewer: Health check DOWN — investigating, see #1234",
      body: MONITOR_AUTHORED_BODY,
    };

    expect(matchesP0Subject(retitled, subject)).toBe(true);
  });

  test("a P0 carrying the subject marker matches even when the title is rewritten entirely", () => {
    const renamed = {
      title: "reviewer is down (rewritten by hand)",
      body: `${MONITOR_AUTHORED_BODY}\n\n${formatP0SubjectMarker("reviewer", "health-down")}\n`,
    };

    expect(matchesP0Subject(renamed, subject)).toBe(true);
  });

  test("the marker is authoritative — a marker for another subject does not fall back to the title", () => {
    const wrongSubject = {
      title: subject.canonicalTitle,
      body: `${MONITOR_AUTHORED_BODY}\n\n${formatP0SubjectMarker("site", "health-down")}\n`,
    };

    expect(matchesP0Subject(wrongSubject, subject)).toBe(false);
  });

  test("a different service's P0 does not match", () => {
    expect(
      matchesP0Subject(
        { title: "[P0] site: Health check DOWN", body: MONITOR_AUTHORED_BODY },
        subject
      )
    ).toBe(false);
  });

  test("the subject marker round-trips, and an unknown class is rejected", () => {
    expect(parseP0SubjectMarker(formatP0SubjectMarker("minsky-mcp", "digest-lag"))).toEqual({
      service: "minsky-mcp",
      failureClass: "digest-lag",
    });
    expect(parseP0SubjectMarker("P0_SUBJECT: minsky-mcp|not-a-class")).toBeNull();
    expect(parseP0SubjectMarker(MONITOR_AUTHORED_BODY)).toBeNull();
  });

  // mt#1495 SC4 — the de-duplication key for the new class.
  const RECOVERY: AlertClass = "recovery-degraded";
  const RECOVERY_TITLE = "[P0] cockpit: DB-pool recovery is stranding connections";

  test("mt#1495: recovery-degraded round-trips as a subject marker, so its P0 coalesces", () => {
    // `parseP0SubjectMarker` validates against ALERT_CLASSES and returns null for
    // anything absent from it. Adding the class to the AlertClass union without
    // adding it here would leave the marker unparseable — every 10-minute run
    // would fail to recognize its own open P0 and file a NEW issue, which is the
    // opposite of coalescing and would page continuously.
    expect(parseP0SubjectMarker(formatP0SubjectMarker("cockpit", RECOVERY))).toEqual({
      service: "cockpit",
      failureClass: RECOVERY,
    });
  });

  test("mt#1495: a recovery-degraded P0 does not collide with another class on the same service", () => {
    // The de-dup key is (service, class), so the same service holding both a
    // health-down and a recovery-degraded P0 must keep them distinct — a service
    // can genuinely be both down and stranding connections.
    const recoveryP0 = {
      title: RECOVERY_TITLE,
      body: `${MONITOR_AUTHORED_BODY}\n\n${formatP0SubjectMarker("cockpit", RECOVERY)}\n`,
    };

    expect(
      matchesP0Subject(recoveryP0, {
        service: "cockpit",
        failureClass: RECOVERY,
        canonicalTitle: RECOVERY_TITLE,
      })
    ).toBe(true);

    expect(
      matchesP0Subject(recoveryP0, {
        service: "cockpit",
        failureClass: "health-down",
        canonicalTitle: "[P0] cockpit: Health check DOWN",
      })
    ).toBe(false);
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
