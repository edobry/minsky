/**
 * Type-level exhaustiveness tests for `AskKind` and `AskState`.
 *
 * These tests exist to catch accidental drift in the Ask taxonomy. If a kind
 * or state is added or removed without updating dependent code, the `switch`
 * statements below will fail TypeScript compilation at the `assertNever` call
 * — the build breaks before the change can merge.
 *
 * This is the mechanical guard referenced in mt#1235 §Success Criteria
 * ("Type-level exhaustiveness check for AskKind") and ADR-008 §The Ask entity
 * (discriminated-union exhaustiveness). Runtime behavior is incidental — the
 * important signal is at compile time.
 */

import { describe, expect, it } from "bun:test";

import type { AskKind, AskState } from "./types";
import { assertNever } from "./types";

/**
 * Exhaustive switch over `AskKind`. If a kind is added to the union without
 * being handled here, TypeScript errors at the `assertNever(kind)` call.
 */
function labelKind(kind: AskKind): string {
  switch (kind) {
    case "capability.escalate":
      return "capability";
    case "information.retrieve":
      return "information";
    case "authorization.approve":
      return "authorization";
    case "direction.decide":
      return "direction";
    case "coordination.notify":
      return "coordination";
    case "quality.review":
      return "quality";
    case "stuck.unblock":
      return "stuck";
    default:
      return assertNever(kind);
  }
}

/**
 * Exhaustive switch over `AskState`. Same pattern as `labelKind`.
 */
function isTerminalState(state: AskState): boolean {
  switch (state) {
    case "detected":
    case "classified":
    case "routed":
    case "suspended":
    case "responded":
      return false;
    case "closed":
    case "cancelled":
    case "expired":
      return true;
    default:
      return assertNever(state);
  }
}

describe("AskKind exhaustiveness", () => {
  it("labels each of the seven kinds without falling through", () => {
    const kinds: AskKind[] = [
      "capability.escalate",
      "information.retrieve",
      "authorization.approve",
      "direction.decide",
      "coordination.notify",
      "quality.review",
      "stuck.unblock",
    ];

    for (const kind of kinds) {
      expect(() => labelKind(kind)).not.toThrow();
    }
  });
});

describe("AskState exhaustiveness", () => {
  it("classifies each of the eight states as terminal or not", () => {
    const nonTerminal: AskState[] = ["detected", "classified", "routed", "suspended", "responded"];
    const terminal: AskState[] = ["closed", "cancelled", "expired"];

    for (const state of nonTerminal) {
      expect(isTerminalState(state)).toBe(false);
    }
    for (const state of terminal) {
      expect(isTerminalState(state)).toBe(true);
    }
  });
});

describe("assertNever runtime behavior", () => {
  it("throws when reached at runtime (should be unreachable in well-typed code)", () => {
    // Forcing a cast to simulate a runtime drift between types and data.
    // In well-typed code, the compiler prevents this.
    expect(() => assertNever("unexpected" as never)).toThrow(/Unhandled variant/);
  });
});
