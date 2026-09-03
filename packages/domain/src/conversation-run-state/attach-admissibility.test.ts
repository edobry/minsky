/**
 * Attach-admissibility tests (mt#3095, extended mt#4869).
 *
 * The whole point of this gate is that its FAILURE mode is silent — a wrong
 * admit forks a transcript with no error anywhere — so these tests assert the
 * decision for every member of the presence union, not just the happy path,
 * AND the roster branch mt#4869 added ahead of it.
 */
import { describe, test, expect } from "bun:test";
import { attachAdmissibility, type AttachRefusalReason } from "./attach-admissibility";
import type { ConversationPresence } from "./presence";
import type { RosterClassification, RosterHolder } from "./claude-code-session-roster";

/** Shared narrowing-failure message, extracted once to avoid the duplication lint. */
const UNREACHABLE_NARROWED = "unreachable — narrowed above";

/** Every member of the union, listed here so a new one fails this file loudly. */
const ALL_PRESENCE: ConversationPresence[] = [
  "LIVE",
  "NEEDS_INPUT",
  "IDLE",
  "STALLED",
  "ENDED",
  "UNKNOWN",
];

/**
 * mt#4869 AT7 (regression): every pre-existing case in this file passes
 * unchanged when the roster reports no holder — i.e. an empty roster.
 */
const EMPTY_ROSTER: RosterClassification = {
  liveness: "not_running",
  holder: null,
  basis: "test: no roster entry",
};

const SAMPLE_HOLDER: RosterHolder = {
  surface: "terminal",
  name: "roster-probe",
  pid: 4242,
  idleForMs: 12_000,
};

const RUNNING_ROSTER: RosterClassification = {
  liveness: "running",
  holder: SAMPLE_HOLDER,
  basis: "test: live process holds this conversation",
};

const UNKNOWN_ROSTER: RosterClassification = {
  liveness: "unknown",
  holder: null,
  basis: "test: roster directory unreadable",
};

describe("attachAdmissibility (mt#3095)", () => {
  test("IDLE admits — the designed case", () => {
    expect(attachAdmissibility("IDLE", EMPTY_ROSTER)).toEqual({ admit: true });
  });

  test("ENDED admits — an observed SessionEnd means nothing holds the file", () => {
    expect(attachAdmissibility("ENDED", EMPTY_ROSTER)).toEqual({ admit: true });
  });

  test.each([
    ["LIVE", "live-writer"],
    ["NEEDS_INPUT", "awaiting-human"],
    ["STALLED", "possibly-wedged"],
    ["UNKNOWN", "no-telemetry"],
  ] as const)("%s refuses with reason %s", (presence, reason) => {
    const result = attachAdmissibility(presence, EMPTY_ROSTER);
    expect(result.admit).toBe(false);
    if (result.admit) throw new Error(UNREACHABLE_NARROWED);
    expect(result.reason).toBe(reason as AttachRefusalReason);
  });

  // The two safety-critical cases, called out separately from the table because
  // they are the ones a future refactor is most likely to "simplify" into an
  // admit: both mean "we cannot see a writer", which is NOT "there is no writer".
  test("UNKNOWN refuses — absence of telemetry is not evidence of idleness", () => {
    const result = attachAdmissibility("UNKNOWN", EMPTY_ROSTER);
    expect(result.admit).toBe(false);
  });

  test("STALLED refuses — a wedged writer still holds the transcript", () => {
    const result = attachAdmissibility("STALLED", EMPTY_ROSTER);
    expect(result.admit).toBe(false);
  });

  test("every presence value yields a decision (no undefined fallthrough)", () => {
    for (const presence of ALL_PRESENCE) {
      const result = attachAdmissibility(presence, EMPTY_ROSTER);
      expect(result).toBeDefined();
      expect(typeof result.admit).toBe("boolean");
    }
  });

  test("every refusal carries a non-empty operator-facing message", () => {
    for (const presence of ALL_PRESENCE) {
      const result = attachAdmissibility(presence, EMPTY_ROSTER);
      if (result.admit) continue;
      expect(result.message.length).toBeGreaterThan(0);
      // The message has to explain the risk, not just name a state — this is
      // what a caller renders when it tells the operator why it will not attach.
      expect(result.message).toMatch(/fork|wedged|writing|telemetry/i);
    }
  });

  test("exactly two of the six presence values admit, with an empty roster", () => {
    const admitted = ALL_PRESENCE.filter((p) => attachAdmissibility(p, EMPTY_ROSTER).admit);
    expect(admitted.sort()).toEqual(["ENDED", "IDLE"]);
  });

  // ── mt#4869: the roster branch ────────────────────────────────────────────

  describe("roster liveness (mt#4869)", () => {
    test("roster running refuses with reason live-elsewhere, holder attached, regardless of presence", () => {
      // IDLE would otherwise admit — the roster must still win.
      const result = attachAdmissibility("IDLE", RUNNING_ROSTER);
      expect(result.admit).toBe(false);
      if (result.admit) throw new Error(UNREACHABLE_NARROWED);
      expect(result.reason).toBe("live-elsewhere");
      expect(result.holder).toEqual(SAMPLE_HOLDER);
      expect(result.message).toMatch(/fork/i);
    });

    test("roster running refuses even when presence is ENDED", () => {
      const result = attachAdmissibility("ENDED", RUNNING_ROSTER);
      expect(result.admit).toBe(false);
    });

    test("roster unknown refuses with reason roster-unknown, message names the roster", () => {
      const result = attachAdmissibility("IDLE", UNKNOWN_ROSTER);
      expect(result.admit).toBe(false);
      if (result.admit) throw new Error(UNREACHABLE_NARROWED);
      expect(result.reason).toBe("roster-unknown");
      expect(result.message).toMatch(/roster/i);
      expect(result.holder).toBeUndefined();
    });

    test("roster not_running falls through to the presence switch unchanged", () => {
      const notRunning: RosterClassification = {
        liveness: "not_running",
        holder: null,
        basis: "test: conversation not held",
      };
      expect(attachAdmissibility("IDLE", notRunning)).toEqual({ admit: true });
      const live = attachAdmissibility("LIVE", notRunning);
      expect(live.admit).toBe(false);
      if (live.admit) throw new Error(UNREACHABLE_NARROWED);
      expect(live.reason).toBe("live-writer");
    });
  });
});
