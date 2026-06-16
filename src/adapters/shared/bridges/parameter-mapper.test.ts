/**
 * normalizeCliParameters tests — focused on the mt#2482 fix: record/object
 * params supplied on the CLI arrive as raw JSON strings and must be JSON-parsed
 * before zod validation.
 */
import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { normalizeCliParameters } from "./parameter-mapper";
import type { CommandParameterDefinition } from "../command-registry";

function def(schema: z.ZodTypeAny, required = false): CommandParameterDefinition {
  return { schema, required } as unknown as CommandParameterDefinition;
}

describe("normalizeCliParameters — structured (record/object) params (mt#2482)", () => {
  test("record param: a JSON string is parsed into an object", () => {
    const schema = { payload: def(z.record(z.string(), z.unknown()), true) };
    const out = normalizeCliParameters(schema, {
      payload: '{"taskId":"mt#2377","newStatus":"DONE"}',
    });
    expect(out.payload).toEqual({ taskId: "mt#2377", newStatus: "DONE" });
  });

  test("object param: a JSON string is parsed and validated against the shape", () => {
    const schema = { cfg: def(z.object({ a: z.string(), n: z.number() })) };
    const out = normalizeCliParameters(schema, { cfg: '{"a":"x","n":3}' });
    expect(out.cfg).toEqual({ a: "x", n: 3 });
  });

  test("optional record param: JSON string still parses (unwrap optional)", () => {
    const schema = { payload: def(z.record(z.string(), z.unknown()).optional()) };
    const out = normalizeCliParameters(schema, { payload: '{"k":1}' });
    expect(out.payload).toEqual({ k: 1 });
  });

  test("refined record param: JSON string parses (refine keeps .type=record)", () => {
    const schema = {
      payload: def(z.record(z.string(), z.unknown()).refine((v) => Object.keys(v).length > 0)),
    };
    const out = normalizeCliParameters(schema, { payload: '{"k":1}' });
    expect(out.payload).toEqual({ k: 1 });
  });

  test("transformed record param: JSON string parses (pipe input is record, mt#2482 R1)", () => {
    const schema = {
      payload: def(z.record(z.string(), z.unknown()).transform((v) => ({ ...v, seen: true }))),
    };
    const out = normalizeCliParameters(schema, { payload: '{"k":1}' });
    expect(out.payload).toEqual({ k: 1, seen: true });
  });

  test("record param already an object (MCP/in-process path) passes through", () => {
    const schema = { payload: def(z.record(z.string(), z.unknown()), true) };
    const obj = { taskId: "mt#1" };
    const out = normalizeCliParameters(schema, { payload: obj });
    expect(out.payload).toEqual(obj);
  });

  test("malformed JSON for a record param throws a clear, single-wrapped error", () => {
    const schema = { payload: def(z.record(z.string(), z.unknown()), true) };
    expect(() => normalizeCliParameters(schema, { payload: "{not json" })).toThrow(
      /expected a JSON record .* not valid JSON/
    );
    // Single-wrapped: the message must not contain the prefix twice.
    try {
      normalizeCliParameters(schema, { payload: "{not json" });
    } catch (e) {
      const msg = (e as Error).message;
      const occurrences = msg.split("Invalid value for parameter").length - 1;
      expect(occurrences).toBe(1);
    }
  });

  test("valid JSON that violates the object shape still yields a zod error", () => {
    const schema = { cfg: def(z.object({ a: z.string() })) };
    expect(() => normalizeCliParameters(schema, { cfg: '{"a":123}' })).toThrow(
      /Invalid value for parameter 'cfg'/
    );
  });
});

describe("normalizeCliParameters — non-structured params are unaffected", () => {
  test("string param passes through untouched (not JSON-parsed)", () => {
    const schema = { name: def(z.string()) };
    const out = normalizeCliParameters(schema, { name: "hello" });
    expect(out.name).toBe("hello");
  });

  test("array param given a string is NOT JSON-parsed (left to zod/commander conventions)", () => {
    // Arrays are deliberately excluded from JSON coercion (mt#2482 rationale).
    const schema = { tags: def(z.array(z.string())) };
    // A pre-collected array (commander repeated flags) validates fine.
    const out = normalizeCliParameters(schema, { tags: ["a", "b"] });
    expect(out.tags).toEqual(["a", "b"]);
  });

  test("union(string|array) param is left alone", () => {
    const schema = { tag: def(z.union([z.string(), z.array(z.string())])) };
    expect(normalizeCliParameters(schema, { tag: "solo" }).tag).toBe("solo");
    expect(normalizeCliParameters(schema, { tag: ["a", "b"] }).tag).toEqual(["a", "b"]);
  });

  test("string.transform param (string input) is NOT JSON-parsed", () => {
    // pipe whose input side is a string → leave the raw string alone.
    const schema = { name: def(z.string().transform((s) => s.toUpperCase())) };
    const out = normalizeCliParameters(schema, { name: "hello" });
    expect(out.name).toBe("HELLO");
  });

  test("optional param omitted is skipped", () => {
    const schema = { payload: def(z.record(z.string(), z.unknown()).optional()) };
    const out = normalizeCliParameters(schema, {});
    expect("payload" in out).toBe(false);
  });
});
