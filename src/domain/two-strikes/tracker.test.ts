/**
 * Tests for the 2-strikes mechanical tracker (mt#1484).
 *
 * Spec acceptance tests (mt#1484 §Acceptance Tests):
 *   1. Two identical tool errors → handler fires exactly once.
 *   2. Error then success then same error → handler does NOT fire.
 *
 * Spec success criteria (mt#1484 §Success Criteria):
 *   - error-on-tool-A then error-on-tool-B doesn't fire.
 *   - Observation-only mode supported (handler invocation gated by config flag).
 *   - Tracker resets per-tool on intervening success.
 *
 * Plus regression coverage for snapshot/fromSnapshot (used by the hook to
 * persist state between invocations) and post-fire reset semantics.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import {
  TwoStrikesTracker,
  fingerprintError,
  type SecondStrikeEvent,
  type TrackerSnapshot,
} from "./tracker";

// ---------------------------------------------------------------------------
// Shared constants (avoid magic-string duplication ESLint warnings)
// ---------------------------------------------------------------------------

const TOOL_BASH = "Bash";
const TOOL_EDIT = "Edit";
const ERR_PERM = "permission denied";
const ERR_NOTFOUND = "file not found";

// A pinned-time `now` factory so timestamp assertions are stable.
function pinnedNow(initial = "2026-05-01T00:00:00.000Z"): { advance: () => string } {
  let count = 0;
  return {
    advance(): string {
      const ts = new Date(new Date(initial).getTime() + count * 1000).toISOString();
      count += 1;
      return ts;
    },
  };
}

// ---------------------------------------------------------------------------
// Live mode — handler invocation
// ---------------------------------------------------------------------------

describe("TwoStrikesTracker — live mode", () => {
  let tracker: TwoStrikesTracker;
  let captured: SecondStrikeEvent[];

  beforeEach(() => {
    const time = pinnedNow();
    tracker = new TwoStrikesTracker({ mode: "live", now: time.advance });
    captured = [];
    tracker.onSecondStrike((event) => {
      captured.push(event);
    });
  });

  // Acceptance test #1.
  test("two identical errors fire the handler exactly once", () => {
    const fired1 = tracker.recordError(TOOL_BASH, new Error(ERR_PERM));
    expect(fired1).toBe(false);
    expect(captured).toHaveLength(0);

    const fired2 = tracker.recordError(TOOL_BASH, new Error(ERR_PERM));
    expect(fired2).toBe(true);
    expect(captured).toHaveLength(1);

    const event = captured[0];
    expect(event).toBeDefined();
    if (!event) return;
    expect(event.toolName).toBe(TOOL_BASH);
    expect(event.normalizedMessage).toBe(ERR_PERM);
    expect(event.errorType).toBe("Error");
    expect(event.firstAt).toBe("2026-05-01T00:00:00.000Z");
    expect(event.secondAt).toBe("2026-05-01T00:00:01.000Z");
    expect(event.fingerprintHash).toMatch(/^[a-f0-9]{40}$/);
  });

  // Acceptance test #2.
  test("error → success → same error does NOT fire (intervening success resets)", () => {
    tracker.recordError(TOOL_BASH, new Error(ERR_PERM));
    tracker.recordSuccess(TOOL_BASH);
    const fired = tracker.recordError(TOOL_BASH, new Error(ERR_PERM));
    expect(fired).toBe(false);
    expect(captured).toHaveLength(0);
  });

  // Spec success criterion: cross-tool errors don't accumulate.
  test("error-on-tool-A then error-on-tool-B doesn't fire", () => {
    const fired1 = tracker.recordError(TOOL_BASH, new Error(ERR_PERM));
    const fired2 = tracker.recordError(TOOL_EDIT, new Error(ERR_PERM));
    expect(fired1).toBe(false);
    expect(fired2).toBe(false);
    expect(captured).toHaveLength(0);
  });

  test("two different errors on the same tool don't fire (different fingerprints)", () => {
    const fired1 = tracker.recordError(TOOL_BASH, new Error(ERR_PERM));
    const fired2 = tracker.recordError(TOOL_BASH, new Error(ERR_NOTFOUND));
    expect(fired1).toBe(false);
    expect(fired2).toBe(false);
    expect(captured).toHaveLength(0);
  });

  // The streak is replaced on different-fingerprint, not stacked. So the
  // sequence err1 → err2 → err2 fires on the third call (second match).
  test("different-fingerprint error replaces (does not stack) the streak", () => {
    tracker.recordError(TOOL_BASH, new Error(ERR_PERM));
    tracker.recordError(TOOL_BASH, new Error(ERR_NOTFOUND));
    const fired = tracker.recordError(TOOL_BASH, new Error(ERR_NOTFOUND));
    expect(fired).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.normalizedMessage).toBe(ERR_NOTFOUND);
  });

  // After firing, the streak resets so a third identical error doesn't
  // immediately re-fire — operator/agent gets one signal per streak.
  test("post-fire reset: third identical error starts a new streak", () => {
    tracker.recordError(TOOL_BASH, new Error(ERR_PERM));
    const fired2 = tracker.recordError(TOOL_BASH, new Error(ERR_PERM));
    expect(fired2).toBe(true);
    expect(captured).toHaveLength(1);

    // Third error is now a "first strike" again.
    const fired3 = tracker.recordError(TOOL_BASH, new Error(ERR_PERM));
    expect(fired3).toBe(false);
    expect(captured).toHaveLength(1);

    // Fourth error fires again (4th total, 2nd of the new streak).
    const fired4 = tracker.recordError(TOOL_BASH, new Error(ERR_PERM));
    expect(fired4).toBe(true);
    expect(captured).toHaveLength(2);
  });

  test("recordSuccess on a tool with no active streak is a no-op", () => {
    expect(() => tracker.recordSuccess(TOOL_BASH)).not.toThrow();
    // And subsequent error→error still fires.
    tracker.recordError(TOOL_BASH, new Error(ERR_PERM));
    const fired = tracker.recordError(TOOL_BASH, new Error(ERR_PERM));
    expect(fired).toBe(true);
  });

  test("getMode returns the configured mode", () => {
    expect(tracker.getMode()).toBe("live");
  });
});

// ---------------------------------------------------------------------------
// Observation mode — gated handler
// ---------------------------------------------------------------------------

describe("TwoStrikesTracker — observation mode", () => {
  let tracker: TwoStrikesTracker;
  let handlerInvoked: number;

  beforeEach(() => {
    const time = pinnedNow();
    tracker = new TwoStrikesTracker({ mode: "observation", now: time.advance });
    handlerInvoked = 0;
    tracker.onSecondStrike(() => {
      handlerInvoked += 1;
    });
  });

  test("default mode is observation", () => {
    const def = new TwoStrikesTracker();
    expect(def.getMode()).toBe("observation");
  });

  test("handler is NOT invoked even when 2-strikes fires", () => {
    tracker.recordError(TOOL_BASH, new Error(ERR_PERM));
    const fired = tracker.recordError(TOOL_BASH, new Error(ERR_PERM));
    expect(fired).toBe(true);
    expect(handlerInvoked).toBe(0);
  });

  test("would-have-fired events accumulate in the observation log", () => {
    tracker.recordError(TOOL_BASH, new Error(ERR_PERM));
    tracker.recordError(TOOL_BASH, new Error(ERR_PERM));
    expect(tracker.getObservations()).toHaveLength(1);

    // Another streak.
    tracker.recordError(TOOL_BASH, new Error(ERR_PERM));
    tracker.recordError(TOOL_BASH, new Error(ERR_PERM));
    expect(tracker.getObservations()).toHaveLength(2);
  });

  test("drainObservations returns and clears", () => {
    tracker.recordError(TOOL_BASH, new Error(ERR_PERM));
    tracker.recordError(TOOL_BASH, new Error(ERR_PERM));

    const drained = tracker.drainObservations();
    expect(drained).toHaveLength(1);
    expect(tracker.getObservations()).toHaveLength(0);
  });

  test("non-firing error sequences don't add observations", () => {
    tracker.recordError(TOOL_BASH, new Error(ERR_PERM));
    tracker.recordError(TOOL_EDIT, new Error(ERR_PERM));
    tracker.recordError(TOOL_BASH, new Error(ERR_NOTFOUND));
    expect(tracker.getObservations()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Snapshot / fromSnapshot (used by the .claude/hooks/ persistence)
// ---------------------------------------------------------------------------

describe("TwoStrikesTracker — snapshot / fromSnapshot", () => {
  test("snapshot captures mode, active streaks, and observations", () => {
    const time = pinnedNow();
    const tracker = new TwoStrikesTracker({ mode: "observation", now: time.advance });
    tracker.recordError(TOOL_BASH, new Error(ERR_PERM));
    tracker.recordError(TOOL_BASH, new Error(ERR_PERM)); // fires → observation
    tracker.recordError(TOOL_EDIT, new Error(ERR_NOTFOUND)); // first strike, active streak

    const snap = tracker.snapshot();
    expect(snap.mode).toBe("observation");
    expect(snap.streaks).toHaveLength(1);
    expect(snap.streaks[0]?.toolName).toBe(TOOL_EDIT);
    expect(snap.observations).toHaveLength(1);
  });

  test("fromSnapshot rehydrates streaks and observations exactly", () => {
    // Use a real fingerprint hash so the rehydrated streak collides with the
    // next recordError call. (The hook's persistence flow rehydrates from a
    // snapshot that was itself produced by a prior recordError, so hashes
    // always match in production.)
    const realHash = fingerprintError(TOOL_BASH, new Error(ERR_PERM)).hash;
    const snap: TrackerSnapshot = {
      mode: "observation",
      streaks: [
        {
          toolName: TOOL_BASH,
          fingerprintHash: realHash,
          normalizedMessage: ERR_PERM,
          errorType: "Error",
          firstAt: "2026-05-01T00:00:00.000Z",
        },
      ],
      observations: [],
    };

    const time = pinnedNow("2026-05-01T01:00:00.000Z");
    const restored = TwoStrikesTracker.fromSnapshot(snap, { now: time.advance });

    // Re-emitting the same fingerprint should now fire (the persisted streak
    // is the first strike from a prior hook invocation).
    const fired = restored.recordError(TOOL_BASH, new Error(ERR_PERM));
    expect(fired).toBe(true);

    const restoredSnap = restored.snapshot();
    expect(restoredSnap.observations).toHaveLength(1);
    expect(restoredSnap.observations[0]?.firstAt).toBe("2026-05-01T00:00:00.000Z");
  });

  test("snapshot is a deep copy (mutating it does not affect the tracker)", () => {
    const time = pinnedNow();
    const tracker = new TwoStrikesTracker({ mode: "observation", now: time.advance });
    tracker.recordError(TOOL_BASH, new Error(ERR_PERM));

    const snap = tracker.snapshot();
    const firstStreak = snap.streaks[0];
    if (firstStreak) {
      firstStreak.normalizedMessage = "MUTATED";
      firstStreak.firstAt = "1970-01-01T00:00:00.000Z";
    }

    const fresh = tracker.snapshot();
    expect(fresh.streaks[0]?.normalizedMessage).toBe(ERR_PERM);
    expect(fresh.streaks[0]?.firstAt).toBe("2026-05-01T00:00:00.000Z");
  });
});
