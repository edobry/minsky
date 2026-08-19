/**
 * `modelTierLabel` — tier resolution for an arbitrary recorded model id (mt#3845).
 *
 * The defect this exists to prevent: `dispatchModelLabelForCanonicalId` matches
 * `canonicalId` EXACTLY, and the registry pins one dated build per tier, so it
 * answers `undefined` for every id that is not the currently-pinned one. As of
 * 2026-08-17 that is every model in the local transcript corpus — all 15,304
 * sampled assistant blocks record `claude-opus-5` while the registry's opus row
 * pins `claude-opus-4-8`. A display path resolving through exact match renders a
 * raw dated id today and goes stale again at the next model bump.
 */
import { describe, test, expect } from "bun:test";
import { modelTierLabel, DISPATCH_MODELS } from "./dispatch-models";

describe("modelTierLabel", () => {
  test("resolves a registry-pinned canonicalId to its curated label", () => {
    for (const model of DISPATCH_MODELS) {
      expect(modelTierLabel(model.canonicalId)).toBe(model.label);
    }
  });

  test("resolves an id the registry does NOT pin — the corpus case", () => {
    // `claude-opus-5` is what every sampled block actually records, and it is
    // not the registry's pinned opus build.
    expect(modelTierLabel("claude-opus-5")).toBe("Opus");
    expect(modelTierLabel("claude-sonnet-4-5-20250929")).toBe("Sonnet");
    expect(modelTierLabel("claude-haiku-9")).toBe("Haiku");
    expect(modelTierLabel("claude-fable-5")).toBe("Fable");
  });

  test("resolves through a vendor prefix", () => {
    expect(modelTierLabel("us.anthropic.claude-opus-5")).toBe("Opus");
  });

  test("is case-insensitive on the tier segment", () => {
    expect(modelTierLabel("claude-OPUS-5")).toBe("Opus");
  });

  test("returns undefined for the synthetic-retry sentinel — never a tier", () => {
    // `<synthetic>` marks a harness-generated retry turn (mt#3260), not a model
    // response. Rendering it as a tier would assert a model spoke when none did.
    expect(modelTierLabel("<synthetic>")).toBeUndefined();
  });

  test("returns undefined for absent, empty, and non-string input", () => {
    expect(modelTierLabel(undefined)).toBeUndefined();
    expect(modelTierLabel(null)).toBeUndefined();
    expect(modelTierLabel("")).toBeUndefined();
    expect(modelTierLabel("   ")).toBeUndefined();
  });

  test("returns undefined for a non-Claude model rather than guessing", () => {
    expect(modelTierLabel("gpt-4o")).toBeUndefined();
    expect(modelTierLabel("gemini-2.5-pro")).toBeUndefined();
  });

  test("does not match a tier word that is not its own segment", () => {
    // The anchoring requirement: a slug that merely CONTAINS a tier word must
    // not resolve on it. Without segment anchors, "opusculum" matches "opus".
    expect(modelTierLabel("claude-opusculum-1")).toBeUndefined();
    expect(modelTierLabel("myclaude-opus")).toBeUndefined();
    expect(modelTierLabel("opus")).toBeUndefined();
  });
});
