/**
 * Regression guard for the Zod-v4 / Vercel AI SDK v4 schema interop bug.
 *
 * AI SDK v4's built-in Zod-to-JSON-Schema converter predates Zod v4's
 * internal restructure and silently emits `{type: "string"}` for any
 * `z.object(...)`. `generateObject` in this service works around that by
 * converting schemas explicitly via Zod v4's native `z.toJSONSchema` and
 * wrapping with the AI SDK's `jsonSchema()` helper.
 *
 * These tests guard the conversion path that `generateObject` relies on —
 * if Zod's JSON Schema output ever starts dropping object shape again,
 * these tests fail before any live AI call is ever attempted.
 *
 * Integration coverage for the full round-trip (Zod → AI SDK → Anthropic →
 * post-parse validation) lives in `scripts/test-provenance-e2e.ts`, which
 * is not part of the test suite because it makes a real paid API call.
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";

describe("z.toJSONSchema for generateObject inputs", () => {
  it("emits type:object with properties for z.object schemas", () => {
    const schema = z.object({
      tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      rationale: z.string(),
      trajectoryChanges: z.array(z.string()),
    });

    const json = z.toJSONSchema(schema) as Record<string, unknown>;

    expect(json.type).toBe("object");
    expect(json.properties).toBeDefined();
    const props = json.properties as Record<string, unknown>;
    expect(props.tier).toBeDefined();
    expect(props.rationale).toBeDefined();
    expect(props.trajectoryChanges).toBeDefined();
  });

  it("preserves number-literal unions as anyOf/const or enum — never as plain string", () => {
    const schema = z.object({
      tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    });

    const json = z.toJSONSchema(schema) as Record<string, unknown>;
    const props = json.properties as Record<string, unknown>;
    const tier = props.tier as Record<string, unknown>;

    const flat = JSON.stringify(tier);
    expect(flat).toContain("1");
    expect(flat).toContain("2");
    expect(flat).toContain("3");
    expect(tier.type).not.toBe("string");
  });

  it("emits type:array for z.array(z.string()) without collapsing", () => {
    const schema = z.object({ items: z.array(z.string()) });
    const json = z.toJSONSchema(schema) as Record<string, unknown>;
    const props = json.properties as Record<string, unknown>;
    const items = props.items as Record<string, unknown>;

    expect(items.type).toBe("array");
    const itemShape = items.items as Record<string, unknown>;
    expect(itemShape.type).toBe("string");
  });

  it("handles the real authorship-judge schema shape end-to-end", () => {
    // Mirrors src/domain/provenance/authorship-judge.ts — the judge call that
    // originally triggered this bug in production. Guards against regressions
    // in the exact shape we pass to the AI SDK.
    const authorshipJudgmentSchema = z.object({
      tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      rationale: z.string(),
      substantiveHumanInput: z.string(),
      trajectoryChanges: z.array(z.string()),
    });

    const json = z.toJSONSchema(authorshipJudgmentSchema) as Record<string, unknown>;
    expect(json.type).toBe("object");
    const props = json.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual([
      "rationale",
      "substantiveHumanInput",
      "tier",
      "trajectoryChanges",
    ]);
  });
});

describe("post-parse validation shape", () => {
  // The completion service does `request.schema.parse(result.object)` after
  // the AI call. These tests pin the Zod behavior that code relies on —
  // mostly a guard against future Zod changes that would weaken validation.
  it("accepts a value matching the schema", () => {
    const schema = z.object({ tier: z.number().int().min(1).max(3), note: z.string() });
    expect(schema.parse({ tier: 2, note: "ok" })).toEqual({ tier: 2, note: "ok" });
  });

  it("rejects a value out of the constrained range", () => {
    const schema = z.object({ tier: z.number().int().min(1).max(3) });
    expect(() => schema.parse({ tier: 4 })).toThrow();
  });

  it("rejects a missing required field", () => {
    const schema = z.object({ tier: z.number(), note: z.string() });
    expect(() => schema.parse({ tier: 1 })).toThrow();
  });

  it("rejects a wrong-typed field", () => {
    const schema = z.object({ tier: z.number() });
    expect(() => schema.parse({ tier: "1" })).toThrow();
  });
});
