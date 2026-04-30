/**
 * Tests for the ClientCapabilityRegistry interface and the no-op default.
 *
 * Reference: mt#1456 spec.
 */

import { describe, expect, test } from "bun:test";
import { NoopClientCapabilityRegistry, type ClientCapabilityRegistry } from "./client-capabilities";

describe("NoopClientCapabilityRegistry", () => {
  test("hasElicitation() returns false", () => {
    const registry = new NoopClientCapabilityRegistry();
    expect(registry.hasElicitation()).toBe(false);
  });

  test("hasElicitation() is stable across calls", () => {
    const registry = new NoopClientCapabilityRegistry();
    expect(registry.hasElicitation()).toBe(false);
    expect(registry.hasElicitation()).toBe(false);
    expect(registry.hasElicitation()).toBe(false);
  });

  test("satisfies the ClientCapabilityRegistry interface contract", () => {
    // Type-level assertion: the no-op is assignable to the interface.
    // If the interface gains required methods, this assignment fails to
    // compile until NoopClientCapabilityRegistry implements them.
    const registry: ClientCapabilityRegistry = new NoopClientCapabilityRegistry();
    expect(typeof registry.hasElicitation).toBe("function");
  });
});
