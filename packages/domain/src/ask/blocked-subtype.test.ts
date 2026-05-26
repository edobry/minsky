/**
 * Tests for BLOCKED subtype derivation helper.
 *
 * Pure function tests — no async, no I/O.
 */

import { describe, it, expect } from "bun:test";
import type { Ask, AskKind } from "./types";
import { deriveBlockedSubtype, formatBlockedStatus } from "./blocked-subtype";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const REQUESTOR = "com.anthropic.claude-code:proc:test-agent";

function makeAsk(kind: AskKind): Ask {
  return {
    id: "ask-test-1",
    kind,
    classifierVersion: "v1.0.0",
    state: "detected",
    requestor: REQUESTOR,
    title: "Test ask",
    question: "What should we do?",
    createdAt: new Date().toISOString(),
    metadata: {},
  };
}

// ---------------------------------------------------------------------------
// deriveBlockedSubtype
// ---------------------------------------------------------------------------

describe("deriveBlockedSubtype", () => {
  it("returns 'other' when ask is null", () => {
    expect(deriveBlockedSubtype(null)).toBe("other");
  });

  it("maps direction.decide to 'direction'", () => {
    expect(deriveBlockedSubtype(makeAsk("direction.decide"))).toBe("direction");
  });

  it("maps quality.review to 'review'", () => {
    expect(deriveBlockedSubtype(makeAsk("quality.review"))).toBe("review");
  });

  it("maps authorization.approve to 'authorization'", () => {
    expect(deriveBlockedSubtype(makeAsk("authorization.approve"))).toBe("authorization");
  });

  it("maps capability.escalate to 'other'", () => {
    expect(deriveBlockedSubtype(makeAsk("capability.escalate"))).toBe("other");
  });

  it("maps information.retrieve to 'other'", () => {
    expect(deriveBlockedSubtype(makeAsk("information.retrieve"))).toBe("other");
  });

  it("maps coordination.notify to 'other'", () => {
    expect(deriveBlockedSubtype(makeAsk("coordination.notify"))).toBe("other");
  });

  it("maps stuck.unblock to 'other'", () => {
    expect(deriveBlockedSubtype(makeAsk("stuck.unblock"))).toBe("other");
  });
});

// ---------------------------------------------------------------------------
// formatBlockedStatus
// ---------------------------------------------------------------------------

describe("formatBlockedStatus", () => {
  it("returns BLOCKED(other) when ask is null", () => {
    expect(formatBlockedStatus(null)).toBe("BLOCKED(other)");
  });

  it("returns BLOCKED(direction) for direction.decide ask", () => {
    expect(formatBlockedStatus(makeAsk("direction.decide"))).toBe("BLOCKED(direction)");
  });

  it("returns BLOCKED(review) for quality.review ask", () => {
    expect(formatBlockedStatus(makeAsk("quality.review"))).toBe("BLOCKED(review)");
  });

  it("returns BLOCKED(authorization) for authorization.approve ask", () => {
    expect(formatBlockedStatus(makeAsk("authorization.approve"))).toBe("BLOCKED(authorization)");
  });

  it("returns BLOCKED(other) for any other ask kind", () => {
    expect(formatBlockedStatus(makeAsk("stuck.unblock"))).toBe("BLOCKED(other)");
  });
});
