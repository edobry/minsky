/**
 * Tests for the dispatchable-model registry (mt#3040).
 */
import { describe, test, expect } from "bun:test";
import {
  DISPATCH_MODELS,
  DEFAULT_DISPATCH_MODEL_ID,
  isDispatchModelId,
  resolveDispatchModelArg,
  dispatchModelLabelForCanonicalId,
} from "./dispatch-models";

describe("dispatch-models registry", () => {
  test("includes Fable with its canonical id claude-fable-5", () => {
    const fable = DISPATCH_MODELS.find((m) => m.id === "fable");
    expect(fable).toBeDefined();
    expect(fable?.canonicalId).toBe("claude-fable-5");
    expect(fable?.modelArg).toBe("fable");
  });

  test("default model id is a registered model", () => {
    expect(DEFAULT_DISPATCH_MODEL_ID).toBe("sonnet");
    expect(isDispatchModelId(DEFAULT_DISPATCH_MODEL_ID)).toBe(true);
  });

  test("every entry has a non-empty label, modelArg, and canonicalId", () => {
    for (const m of DISPATCH_MODELS) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.modelArg.length).toBeGreaterThan(0);
      expect(m.canonicalId.length).toBeGreaterThan(0);
    }
  });

  test("model ids are unique", () => {
    const ids = DISPATCH_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("isDispatchModelId accepts registered ids and rejects everything else", () => {
    expect(isDispatchModelId("fable")).toBe(true);
    expect(isDispatchModelId("opus")).toBe(true);
    expect(isDispatchModelId("gpt-4o")).toBe(false);
    expect(isDispatchModelId("")).toBe(false);
    expect(isDispatchModelId(null)).toBe(false);
    expect(isDispatchModelId(42)).toBe(false);
  });

  test("resolveDispatchModelArg maps id → alias and returns undefined for unknown", () => {
    expect(resolveDispatchModelArg("fable")).toBe("fable");
    expect(resolveDispatchModelArg("sonnet")).toBe("sonnet");
    expect(resolveDispatchModelArg("nonesuch")).toBeUndefined();
  });

  describe("dispatchModelLabelForCanonicalId (mt#3070 reverse lookup)", () => {
    test("maps every registered canonicalId to its label", () => {
      for (const m of DISPATCH_MODELS) {
        expect(dispatchModelLabelForCanonicalId(m.canonicalId)).toBe(m.label);
      }
    });

    test("returns undefined for an id with no matching canonicalId — callers render the raw id instead of guessing", () => {
      expect(dispatchModelLabelForCanonicalId("gpt-4o")).toBeUndefined();
      expect(dispatchModelLabelForCanonicalId("claude-sonnet-4-2026-01-01")).toBeUndefined();
      expect(dispatchModelLabelForCanonicalId("")).toBeUndefined();
    });
  });
});
