/**
 * Tests for the unescalated-incident Stop guard (mt#3593).
 *
 * The load-bearing test is the LAST one: it pins that the guard does NOT fire
 * merely because `principal_notify` is absent. That is the exact regression the
 * spec's superseded predicate would reintroduce — after mt#3595, a correctly
 * handled incident contains no such call by design, so a notify-absence check
 * would fire on every correct handling and push the agent toward an action the
 * amended rule forbids.
 */

import { describe, expect, it } from "bun:test";
import {
  ASK_TOOL,
  detectUnescalatedIncident,
  turnFiledSeverityAsk,
} from "./turn-end-unescalated-incident-scan";

/** The R2 turn (2026-08-03): production down, revert un-pushable, nothing filed. */
const R2_MESSAGE =
  "I broke production — the merge took minsky-mcp down and the health probe reports " +
  "persistence unavailable. I can't push the revert: the pre-push gate blocks it and its " +
  "escape hatch is an env var I can't reach from inside the session.";

/** The R1 turn (2026-07-31): reviewer failing every review, billing is the operator's. */
const R1_MESSAGE =
  "The reviewer has been failing every review since 02:30Z — 429, no credits remaining. " +
  "I can't top up the billing account; only you can do that.";

function userLine(text: string) {
  return { type: "user", message: { role: "user", content: text } } as const;
}

function askCall(input: Record<string, unknown>) {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_ask", name: ASK_TOOL, input }],
    },
  } as const;
}

function notifyCall() {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_notify",
          name: "mcp__minsky__principal_notify",
          input: { message: "prod is down" },
        },
      ],
    },
  } as const;
}

const NO_CALLS = [userLine("did it land?")] as never[];

describe("turnFiledSeverityAsk", () => {
  it("is true only for an ask carrying severity: incident", () => {
    const lines = [userLine("x"), askCall({ severity: "incident", title: "prod down" })];
    expect(turnFiledSeverityAsk(lines as never[])).toBe(true);
  });

  it("is FALSE for an ask with no severity marker — the R1 shape", () => {
    // R1 filed an ask and the principal still was not told. An ask that cannot
    // notify must not read as discharge.
    const lines = [userLine("x"), askCall({ title: "reviewer down", forceImmediate: true })];
    expect(turnFiledSeverityAsk(lines as never[])).toBe(false);
  });

  it("is false when no ask was filed at all", () => {
    expect(turnFiledSeverityAsk(NO_CALLS)).toBe(false);
  });
});

describe("detectUnescalatedIncident", () => {
  it("AT1 — fires on the 2026-08-03 turn (incident + operator-only, nothing filed)", () => {
    const found = detectUnescalatedIncident(R2_MESSAGE, NO_CALLS);
    expect(found).not.toBeNull();
    expect(found?.incident.length).toBeGreaterThan(0);
    expect(found?.operatorOnly.length).toBeGreaterThan(0);
  });

  it("AT2 — does NOT fire when the turn filed a severity ask", () => {
    const lines = [userLine("x"), askCall({ severity: "incident", title: "prod down" })];
    expect(detectUnescalatedIncident(R2_MESSAGE, lines as never[])).toBeNull();
  });

  it("is satisfied by severity ALONE — forceImmediate is not a prerequisite", () => {
    // Pins the guard's contract against the amended rule: `severity` controls
    // the NOTIFICATION, `forceImmediate` only controls whether the ask waits for
    // a service window. Neither gates the other, so an ask carrying severity and
    // nothing else fully discharges the obligation this guard checks.
    const lines = [userLine("x"), askCall({ severity: "incident", title: "prod down" })];
    expect(turnFiledSeverityAsk(lines as never[])).toBe(true);
    expect(detectUnescalatedIncident(R2_MESSAGE, lines as never[])).toBeNull();
  });

  it("AT4 — fires on the 2026-07-31 shape: an ask WITHOUT severity is not discharge", () => {
    const lines = [userLine("x"), askCall({ title: "reviewer down", forceImmediate: true })];
    expect(detectUnescalatedIncident(R1_MESSAGE, lines as never[])).not.toBeNull();
  });

  it("does NOT fire on notify-absence alone — the superseded predicate's regression", () => {
    // A correctly-handled incident post-mt#3595: severity ask filed, and NO
    // principal_notify, because the rule now tells the agent not to send one.
    // The old predicate fired exactly here. This must stay silent.
    const lines = [userLine("x"), askCall({ severity: "incident", title: "prod down" })];
    expect(detectUnescalatedIncident(R2_MESSAGE, lines as never[])).toBeNull();
  });

  it("also stays silent when a severity ask AND a notify both happened", () => {
    const lines = [
      userLine("x"),
      askCall({ severity: "incident", title: "prod down" }),
      notifyCall(),
    ];
    expect(detectUnescalatedIncident(R2_MESSAGE, lines as never[])).toBeNull();
  });

  it("AT3 — over-fire control: an incident the agent can fix itself does not fire", () => {
    const msg =
      "The deploy is down — the container crash-looped on a bad env var. " +
      "I've corrected it and redeployed; it is healthy now.";
    expect(detectUnescalatedIncident(msg, NO_CALLS)).toBeNull();
  });

  it("over-fire control: operator-only with no incident does not fire", () => {
    const msg = "I can't push this without your approval on the naming decision.";
    expect(detectUnescalatedIncident(msg, NO_CALLS)).toBeNull();
  });

  it("does not fire on a turn merely DISCUSSING the guard", () => {
    // The precision half. The family's recorded false positives were agents
    // quoting the trigger vocabulary while discussing it; elision is what keeps
    // this guard out of that history.
    const msg =
      'This guard fires when a turn says "production is down" and "I can\'t push", ' +
      "which is the pair it keys on.";
    expect(detectUnescalatedIncident(msg, NO_CALLS)).toBeNull();
  });

  it("ignores an incident stated far above the scanned tail", () => {
    const msg = `${"Production is down and I can't push the fix. "}${"filler. ".repeat(400)}`;
    expect(detectUnescalatedIncident(msg, NO_CALLS)).toBeNull();
  });
});
