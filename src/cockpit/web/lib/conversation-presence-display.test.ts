/**
 * Tests for the presence/activity presentation rules (mt#3261).
 *
 * The load-bearing cases here are the ones mt#3130 calls out as non-negotiable:
 * the `NEEDS INPUT` reason sub-label is never bare, the `LIVE` activity line
 * always carries elapsed time, and the silence modifier attaches only to the
 * resting values.
 */
import { describe, expect, test } from "bun:test";
import type { ConversationPresencePayload } from "../hooks/useConversationPresence";
import {
  NEEDS_INPUT_REASON_LABEL,
  PRESENCE_LABEL,
  PRESENCE_TONE,
  advanceFrom,
  describeActivity,
  describeSilence,
  formatElapsed,
  formatQuietFor,
  needsInputReasonLabel,
} from "./conversation-presence-display";

function payload(over: Partial<ConversationPresencePayload> = {}): ConversationPresencePayload {
  return {
    presence: "IDLE",
    needsInputReason: null,
    needsInputTool: null,
    toolName: null,
    toolElapsedMs: null,
    quietForMs: null,
    isQuiet: false,
    basis: "stopped",
    conversationId: "c1",
    ask: null,
    ...over,
  };
}

describe("labels", () => {
  test("every presence value has a label and a tone", () => {
    for (const value of ["LIVE", "NEEDS_INPUT", "IDLE", "STALLED", "ENDED", "UNKNOWN"] as const) {
      expect(PRESENCE_LABEL[value]).toBeTruthy();
      expect(PRESENCE_TONE[value]).toBeTruthy();
    }
  });

  test("NEEDS_INPUT renders as spaced words, not the raw enum", () => {
    expect(PRESENCE_LABEL.NEEDS_INPUT).toBe("NEEDS INPUT");
  });

  test("STALLED is present as a sixth value (mt#3201 decision)", () => {
    expect(PRESENCE_LABEL.STALLED).toBe("STALLED");
  });
});

describe("formatElapsed", () => {
  test("sub-minute reads in seconds so a fast call visibly advances", () => {
    expect(formatElapsed(7_000)).toBe("7s");
  });

  test("minutes carry zero-padded seconds", () => {
    expect(formatElapsed(125_000)).toBe("2m 05s");
  });

  test("hours carry zero-padded minutes", () => {
    expect(formatElapsed(3_840_000)).toBe("1h 04m");
  });

  test("negative or non-finite input degrades to 0s rather than NaN", () => {
    expect(formatElapsed(-5)).toBe("0s");
    expect(formatElapsed(Number.NaN)).toBe("0s");
  });
});

describe("formatQuietFor", () => {
  test("under a minute is explicitly sub-minute, not '0m'", () => {
    expect(formatQuietFor(30_000)).toBe("<1m");
  });

  test("minutes, hours, days", () => {
    expect(formatQuietFor(12 * 60_000)).toBe("12m");
    expect(formatQuietFor(3 * 3_600_000)).toBe("3h");
    expect(formatQuietFor(50 * 3_600_000)).toBe("2d");
  });
});

describe("advanceFrom", () => {
  test("adds real elapsed wall-clock time to the server measurement", () => {
    expect(advanceFrom(1_000, 10_000, 13_000)).toBe(4_000);
  });

  test("never runs backwards when now precedes the fetch", () => {
    expect(advanceFrom(1_000, 10_000, 9_000)).toBe(1_000);
  });

  test("null measurement stays null — no invented duration", () => {
    expect(advanceFrom(null, 10_000, 13_000)).toBeNull();
  });
});

describe("describeActivity", () => {
  test("LIVE with a running tool names the tool AND the elapsed time", () => {
    const line = describeActivity(
      payload({ presence: "LIVE", toolName: "Bash", toolElapsedMs: 2_000 }),
      1_000,
      4_000
    );
    // 2s measured + 3s since the fetch landed.
    expect(line).toBe("Running Bash · 5s");
  });

  test("LIVE with no named tool reads as thinking", () => {
    expect(describeActivity(payload({ presence: "LIVE" }), 0, 0)).toBe("Thinking…");
  });

  test("LIVE with a tool but no measured elapsed still names the tool", () => {
    // Degrades to a named activity rather than a bare indeterminate spinner.
    expect(describeActivity(payload({ presence: "LIVE", toolName: "Grep" }), 0, 0)).toBe(
      "Running Grep"
    );
  });

  test("STALLED still describes the work it was last seen doing", () => {
    expect(
      describeActivity(payload({ presence: "STALLED", toolName: "Bash", toolElapsedMs: 0 }), 0, 0)
    ).toBe("Running Bash · 0s");
  });

  test("resting values render no activity line at all", () => {
    for (const presence of ["IDLE", "NEEDS_INPUT", "ENDED", "UNKNOWN"] as const) {
      expect(describeActivity(payload({ presence, toolName: "Bash" }), 0, 0)).toBeNull();
    }
  });
});

describe("describeSilence", () => {
  test("attaches to IDLE when the endpoint reports quiet", () => {
    expect(
      describeSilence(payload({ presence: "IDLE", isQuiet: true, quietForMs: 720_000 }), 0, 0)
    ).toBe("quiet 12m");
  });

  test("attaches to NEEDS_INPUT too", () => {
    expect(
      describeSilence(
        payload({ presence: "NEEDS_INPUT", isQuiet: true, quietForMs: 3_600_000 }),
        0,
        0
      )
    ).toBe("quiet 1h");
  });

  test("never attaches to LIVE or STALLED — the more specific answer wins", () => {
    for (const presence of ["LIVE", "STALLED"] as const) {
      expect(
        describeSilence(payload({ presence, isQuiet: true, quietForMs: 720_000 }), 0, 0)
      ).toBeNull();
    }
  });

  test("absent when the endpoint did not flag quiet", () => {
    expect(
      describeSilence(payload({ presence: "IDLE", isQuiet: false, quietForMs: 720_000 }), 0, 0)
    ).toBeNull();
  });

  test("advances with wall-clock time between polls", () => {
    expect(
      describeSilence(payload({ presence: "IDLE", isQuiet: true, quietForMs: 60_000 }), 0, 120_000)
    ).toBe("quiet 3m");
  });
});

describe("needsInputReasonLabel", () => {
  test("null for every presence value other than NEEDS_INPUT", () => {
    for (const presence of ["LIVE", "IDLE", "STALLED", "ENDED", "UNKNOWN"] as const) {
      expect(needsInputReasonLabel(payload({ presence }))).toBeNull();
    }
  });

  test("every reason the domain can emit has a label", () => {
    for (const reason of [
      "permission",
      "idle-prompt",
      "agent-needs-input",
      "ask",
      "unknown",
    ] as const) {
      expect(NEEDS_INPUT_REASON_LABEL[reason]).toBeTruthy();
      expect(
        needsInputReasonLabel(payload({ presence: "NEEDS_INPUT", needsInputReason: reason }))
      ).toBeTruthy();
    }
  });

  test("a missing reason still yields a label — decision (2) forbids the bare form", () => {
    const label = needsInputReasonLabel(
      payload({ presence: "NEEDS_INPUT", needsInputReason: null })
    );
    expect(label).toBe(NEEDS_INPUT_REASON_LABEL.unknown);
  });

  test("a permission prompt names the tool it is gated on", () => {
    expect(
      needsInputReasonLabel(
        payload({
          presence: "NEEDS_INPUT",
          needsInputReason: "permission",
          needsInputTool: "Bash",
        })
      )
    ).toBe("permission: Bash");
  });
});
