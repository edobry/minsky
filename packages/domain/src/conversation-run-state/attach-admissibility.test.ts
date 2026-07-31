/**
 * Attach-admissibility tests (mt#3095).
 *
 * The whole point of this gate is that its FAILURE mode is silent — a wrong
 * admit forks a transcript with no error anywhere — so these tests assert the
 * decision for every member of the presence union, not just the happy path.
 */
import { describe, test, expect } from "bun:test";
import { attachAdmissibility, type AttachRefusalReason } from "./attach-admissibility";
import type { ConversationPresence } from "./presence";

/** Every member of the union, listed here so a new one fails this file loudly. */
const ALL_PRESENCE: ConversationPresence[] = [
  "LIVE",
  "NEEDS_INPUT",
  "IDLE",
  "STALLED",
  "ENDED",
  "UNKNOWN",
];

describe("attachAdmissibility (mt#3095)", () => {
  test("IDLE admits — the designed case", () => {
    expect(attachAdmissibility("IDLE")).toEqual({ admit: true });
  });

  test("ENDED admits — an observed SessionEnd means nothing holds the file", () => {
    expect(attachAdmissibility("ENDED")).toEqual({ admit: true });
  });

  test.each([
    ["LIVE", "live-writer"],
    ["NEEDS_INPUT", "awaiting-human"],
    ["STALLED", "possibly-wedged"],
    ["UNKNOWN", "no-telemetry"],
  ] as const)("%s refuses with reason %s", (presence, reason) => {
    const result = attachAdmissibility(presence);
    expect(result.admit).toBe(false);
    if (result.admit) throw new Error("unreachable — narrowed above");
    expect(result.reason).toBe(reason as AttachRefusalReason);
  });

  // The two safety-critical cases, called out separately from the table because
  // they are the ones a future refactor is most likely to "simplify" into an
  // admit: both mean "we cannot see a writer", which is NOT "there is no writer".
  test("UNKNOWN refuses — absence of telemetry is not evidence of idleness", () => {
    const result = attachAdmissibility("UNKNOWN");
    expect(result.admit).toBe(false);
  });

  test("STALLED refuses — a wedged writer still holds the transcript", () => {
    const result = attachAdmissibility("STALLED");
    expect(result.admit).toBe(false);
  });

  test("every presence value yields a decision (no undefined fallthrough)", () => {
    for (const presence of ALL_PRESENCE) {
      const result = attachAdmissibility(presence);
      expect(result).toBeDefined();
      expect(typeof result.admit).toBe("boolean");
    }
  });

  test("every refusal carries a non-empty operator-facing message", () => {
    for (const presence of ALL_PRESENCE) {
      const result = attachAdmissibility(presence);
      if (result.admit) continue;
      expect(result.message.length).toBeGreaterThan(0);
      // The message has to explain the risk, not just name a state — this is
      // what a caller renders when it tells the operator why it will not attach.
      expect(result.message).toMatch(/fork|wedged|writing|telemetry/i);
    }
  });

  test("exactly two of the six presence values admit", () => {
    const admitted = ALL_PRESENCE.filter((p) => attachAdmissibility(p).admit);
    expect(admitted.sort()).toEqual(["ENDED", "IDLE"]);
  });
});
