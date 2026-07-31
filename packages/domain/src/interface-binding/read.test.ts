/**
 * Tests for the read-side `interfaceBinding` defaulting helper (mt#1628).
 */
import { describe, test, expect } from "bun:test";
import { resolveInterfaceBinding } from "./read";

describe("resolveInterfaceBinding", () => {
  test("returns the stored binding verbatim when present", () => {
    const stored = {
      kind: "iterm-tab" as const,
      surfaceId: "w0t0p0:AAA",
      lastObservedAt: "2026-07-16T00:00:00.000Z",
    };
    const result = resolveInterfaceBinding({
      interfaceBinding: stored,
      lastActivityAt: "2026-07-16T01:00:00.000Z",
      createdAt: "2026-07-15T00:00:00.000Z",
    });
    expect(result).toEqual(stored);
  });

  test("defaults to unbound using lastActivityAt when no binding has ever been observed", () => {
    const result = resolveInterfaceBinding({
      lastActivityAt: "2026-07-16T01:00:00.000Z",
      createdAt: "2026-07-15T00:00:00.000Z",
    });
    expect(result).toEqual({ kind: "unbound", lastObservedAt: "2026-07-16T01:00:00.000Z" });
  });

  test("falls back to createdAt when lastActivityAt is absent (e.g. hosted-Minsky session)", () => {
    const result = resolveInterfaceBinding({ createdAt: "2026-07-15T00:00:00.000Z" });
    expect(result).toEqual({ kind: "unbound", lastObservedAt: "2026-07-15T00:00:00.000Z" });
  });

  test("never throws even when neither timestamp is present", () => {
    const result = resolveInterfaceBinding({});
    expect(result.kind).toBe("unbound");
    expect(typeof result.lastObservedAt).toBe("string");
  });
});
