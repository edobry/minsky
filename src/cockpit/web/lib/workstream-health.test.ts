/**
 * Tests for workstream health derivation (mt#2885).
 */
import { describe, expect, test } from "bun:test";
import {
  streamHealth,
  STREAM_HEALTH_RANK,
  STALL_THRESHOLD_MS,
  type HealthReadableCard,
} from "./workstream-health";

const NOW = new Date("2026-07-17T12:00:00Z").getTime();
const FRESH = "2026-07-16T12:00:00Z"; // 1d ago
const STALE = new Date(NOW - STALL_THRESHOLD_MS - 24 * 60 * 60 * 1000).toISOString(); // 6d ago

function card(overrides: Partial<HealthReadableCard>): HealthReadableCard {
  return {
    parentId: "mt#2880",
    children: [
      { id: "mt#2881", status: "DONE" },
      { id: "mt#2885", status: "IN-PROGRESS" },
    ],
    lastActivityAt: FRESH,
    ...overrides,
  };
}

describe("streamHealth", () => {
  const noAsks = new Set<string>();

  test("an open ask bound to the parent makes the stream blocked-on-you", () => {
    const h = streamHealth(card({}), new Set(["mt#2880"]), NOW);
    expect(h.state).toBe("blocked-on-you");
    expect(h.openAskCount).toBe(1);
  });

  test("an open ask bound to a CHILD also blocks the stream", () => {
    const h = streamHealth(card({}), new Set(["mt#2885"]), NOW);
    expect(h.state).toBe("blocked-on-you");
  });

  test("no motion past the 5d threshold is stalled, with day count", () => {
    const h = streamHealth(card({ lastActivityAt: STALE }), noAsks, NOW);
    expect(h.state).toBe("stalled");
    expect(h.daysSinceActivity).toBe(6);
  });

  test("blocked-on-you outranks stalled", () => {
    const h = streamHealth(card({ lastActivityAt: STALE }), new Set(["mt#2880"]), NOW);
    expect(h.state).toBe("blocked-on-you");
  });

  test("a child at IN-REVIEW marks awaiting-review on a fresh stream", () => {
    const h = streamHealth(
      card({ children: [{ id: "mt#2885", status: "IN-REVIEW" }] }),
      noAsks,
      NOW
    );
    expect(h.state).toBe("awaiting-review");
    expect(h.inReviewCount).toBe(1);
  });

  test("fresh stream with no signals is moving", () => {
    const h = streamHealth(card({}), noAsks, NOW);
    expect(h.state).toBe("moving");
    expect(h.daysSinceActivity).toBe(1);
  });

  test("no timestamp: never stalled, daysSinceActivity null", () => {
    const h = streamHealth(card({ lastActivityAt: null }), noAsks, NOW);
    expect(h.state).toBe("moving");
    expect(h.daysSinceActivity).toBeNull();
  });

  test("rank order: blocked-on-you < stalled < awaiting-review < moving", () => {
    expect(STREAM_HEALTH_RANK["blocked-on-you"]).toBeLessThan(STREAM_HEALTH_RANK.stalled);
    expect(STREAM_HEALTH_RANK.stalled).toBeLessThan(STREAM_HEALTH_RANK["awaiting-review"]);
    expect(STREAM_HEALTH_RANK["awaiting-review"]).toBeLessThan(STREAM_HEALTH_RANK.moving);
  });
});
