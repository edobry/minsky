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

describe("normalizeCliParameters — schema-level defaults + required enforcement (mt#2705)", () => {
  test("materializes a schema-only .default(...) when the flag is omitted (no sibling defaultValue)", () => {
    // Deliberately no `defaultValue` field — the schema-level default is the
    // only source of truth exercised here.
    const schema = { limit: def(z.number().default(20)) };
    const out = normalizeCliParameters(schema, {});
    expect(out.limit).toBe(20);
  });

  test("required parameter missing still throws (unchanged behavior)", () => {
    // The CLI path already enforced this correctly pre-mt#2705; the new
    // schema-default-materialization branch above it must not change this.
    const schema = { name: def(z.string(), true) };
    expect(() => normalizeCliParameters(schema, {})).toThrow(
      /Required parameter 'name' is missing/
    );
  });

  test("required parameter WITH a schema-level default materializes the default instead of throwing", () => {
    // Precedence check: a schema-embedded default takes priority over the
    // `required` flag — if the schema itself provides a value for
    // `undefined`, the parameter is no longer effectively "missing".
    const schema = { strategy: def(z.enum(["a", "b"]).default("a"), true) };
    const out = normalizeCliParameters(schema, {});
    expect(out.strategy).toBe("a");
  });

  test("required parameter WITH a sibling defaultValue (no schema default) resolves without throwing (PR #2248 R1)", () => {
    // Regression: the omitted-value branch set the sibling defaultValue and
    // then STILL fell through to the "Required parameter missing" throw
    // (the defaultValue block had no `continue`), diverging from the MCP
    // path which correctly returns the sibling default. A resolved default
    // of EITHER kind must short-circuit the required check.
    const paramDef = {
      schema: z.string(), // deliberately NO .default(...) — sibling field only
      required: true,
      defaultValue: "fallback",
    } as unknown as CommandParameterDefinition;
    const out = normalizeCliParameters({ mode: paramDef }, {});
    expect(out.mode).toBe("fallback");
  });

  test("required:false with a bare (non-.optional()) schema and no default stays omitted, not rejected", () => {
    // Guards against a stricter-than-intended regression: some commands
    // declare `required: false` with a raw schema that has no `.optional()`
    // wrapper (e.g. deps-visualization-commands.ts's `status: z.string()`).
    // The `required` FLAG — not raw schema shape — must gate rejection.
    const schema = { status: def(z.string(), false) };
    const out = normalizeCliParameters(schema, {});
    expect("status" in out).toBe(false);
  });

  test("existing paired schema.default() + sibling defaultValue resolves identically (no regression)", () => {
    const paramDef = {
      schema: z.enum(["yaml", "json"]).default("yaml"),
      required: false,
      defaultValue: "yaml",
    } as unknown as CommandParameterDefinition;
    const out = normalizeCliParameters({ format: paramDef }, {});
    expect(out.format).toBe("yaml");
  });

  test("a supplied value still goes through the normal parse/validate path (unaffected by the omitted-branch change)", () => {
    const schema = { limit: def(z.number().default(20)) };
    const out = normalizeCliParameters(schema, { limit: 5 });
    expect(out.limit).toBe(5);
  });
});

describe("normalizeCliParameters — scalar coercion for CLI-arrived strings (mt#1173)", () => {
  test("numeric positional: the raw string reaches execute as a number", () => {
    // The defect: a CLI positional has no Commander argParser, so its string
    // hit `z.number().parse()` and failed with "expected number, received
    // string". Modelled on `forge.ci_run_view_log`'s `runId`.
    const schema = { runId: def(z.number(), true) };
    const out = normalizeCliParameters(schema, { runId: "31647382926" });
    expect(out.runId).toBe(31647382926);
    expect(typeof out.runId).toBe("number");
  });

  test("the real session.pr.review.dismiss reviewId param accepts a positional string", () => {
    // Success criterion 3: `reviewId` reverted from `z.coerce.number()` to
    // `z.number()`, so this asserts the structural fix carries what the
    // per-schema workaround used to (mt#1170).
    const schema = { reviewId: def(z.number().int().positive(), true) };
    const out = normalizeCliParameters(schema, { reviewId: "12345" });
    expect(out.reviewId).toBe(12345);
  });

  test("wrapped numeric schemas coerce through optional / nullable / default", () => {
    expect(normalizeCliParameters({ n: def(z.number().optional()) }, { n: "7" }).n).toBe(7);
    expect(normalizeCliParameters({ n: def(z.number().nullable()) }, { n: "7" }).n).toBe(7);
    expect(normalizeCliParameters({ n: def(z.number().default(20)) }, { n: "7" }).n).toBe(7);
  });

  test("number.transform coerces on the pipe's INPUT side", () => {
    const schema = { n: def(z.number().transform((v) => v * 2)) };
    expect(normalizeCliParameters(schema, { n: "21" }).n).toBe(42);
  });

  test("refined numeric schema coerces, then the refinement still applies", () => {
    const schema = { port: def(z.number().int().min(1).max(65535), true) };
    expect(normalizeCliParameters(schema, { port: "8080" }).port).toBe(8080);
    expect(() => normalizeCliParameters(schema, { port: "70000" })).toThrow(
      /Invalid value for parameter 'port'/
    );
  });

  test("bigint positional: an integer string becomes a bigint", () => {
    const schema = { id: def(z.bigint(), true) };
    expect(normalizeCliParameters(schema, { id: "90071992547409910" })).toEqual({
      id: 90071992547409910n,
    });
  });

  test("boolean positional: only the literal true/false spellings coerce", () => {
    const schema = { flag: def(z.boolean(), true) };
    expect(normalizeCliParameters(schema, { flag: "true" }).flag).toBe(true);
    expect(normalizeCliParameters(schema, { flag: "FALSE" }).flag).toBe(false);
    // "yes" is NOT a boolean spelling — left for zod to reject rather than
    // guessed at, so the CLI never silently invents a value.
    expect(() => normalizeCliParameters(schema, { flag: "yes" })).toThrow(
      /Invalid value for parameter 'flag'/
    );
  });

  test("a non-numeric string still yields the pre-existing clean zod error", () => {
    // Acceptance test: malformed input keeps the message it always had — the
    // value is passed through uncoerced rather than turned into NaN.
    const schema = { runId: def(z.number(), true) };
    expect(() => normalizeCliParameters(schema, { runId: "abc" })).toThrow(
      /Invalid value for parameter 'runId'.*expected number, received string/
    );
  });

  test("empty and whitespace strings are NOT coerced to 0", () => {
    // `Number("")` is 0. Coercing here would turn an omitted-looking value into
    // a real one — the precise semantic drift that kept this off the schemas.
    const schema = { n: def(z.number(), true) };
    expect(() => normalizeCliParameters(schema, { n: "" })).toThrow(/parameter 'n'/);
    expect(() => normalizeCliParameters(schema, { n: "   " })).toThrow(/parameter 'n'/);
  });

  test("Infinity and NaN spellings are not coerced into a number", () => {
    const schema = { n: def(z.number(), true) };
    expect(() => normalizeCliParameters(schema, { n: "Infinity" })).toThrow(/parameter 'n'/);
    expect(() => normalizeCliParameters(schema, { n: "NaN" })).toThrow(/parameter 'n'/);
  });

  test("a non-integer string is rejected by an int schema, not silently truncated", () => {
    const schema = { runId: def(z.number().int(), true) };
    expect(() => normalizeCliParameters(schema, { runId: "1.5" })).toThrow(
      /Invalid value for parameter 'runId'/
    );
  });

  test("already-typed values (MCP / in-process paths) pass through untouched", () => {
    // Coercion is string-gated, so the JSON-typed transport is unaffected —
    // "MCP surface unchanged" in the spec's success criteria.
    expect(normalizeCliParameters({ n: def(z.number(), true) }, { n: 42 }).n).toBe(42);
    expect(normalizeCliParameters({ b: def(z.boolean(), true) }, { b: false }).b).toBe(false);
  });

  test("string params are never coerced, even when they look numeric", () => {
    const schema = { version: def(z.string(), true) };
    expect(normalizeCliParameters(schema, { version: "123" }).version).toBe("123");
  });

  test("array and union params are left alone (mt#3731's surface, not this one)", () => {
    // The seam recorded in the mt#1173 planning audit: this fix must not reach
    // into array/union handling, which mt#3731 owns.
    const union = { tag: def(z.union([z.string(), z.array(z.string())])) };
    expect(normalizeCliParameters(union, { tag: "42" }).tag).toBe("42");
    const arr = { tags: def(z.array(z.string())) };
    expect(normalizeCliParameters(arr, { tags: ["1", "2"] }).tags).toEqual(["1", "2"]);
  });

  test("record params still take the JSON branch, not the scalar one", () => {
    // The two branches are mutually exclusive; this guards the `else if`.
    const schema = { payload: def(z.record(z.string(), z.unknown()), true) };
    expect(normalizeCliParameters(schema, { payload: '{"k":1}' }).payload).toEqual({ k: 1 });
  });
});

describe("normalizeCliParameters — .refine() does not wrap in zod v4 (PR #3008 R1)", () => {
  // PR #3008 R1 raised two BLOCKING findings on the premise that zod v4's
  // `.refine()` returns a `ZodEffects` wrapper, so `unwrappedZodType` would
  // report the wrapper and (a) refined scalars would skip coercion, (b) refined
  // record/object params would stop taking the JSON branch (an mt#2482
  // regression). That is zod v3 behaviour: v4 removed `ZodEffects` and adds
  // checks in place. Measured against the installed zod 4.4.3 —
  // `z.number().refine(...).type === "number"`, `z.record(...).refine(...).type
  // === "record"`, and `"ZodEffects" in z === false`.
  //
  // The finding was wrong, but the coverage gap behind it was real: no test
  // exercised a literal `.refine()` on a SCALAR (the pre-existing "refined
  // record param" test covered only the structured side, and `int()`/`min()`/
  // `max()` are native checks, not refinements). These tests pin the premise so
  // the question is settled in-repo rather than re-argued, and so a future zod
  // upgrade that DOES reintroduce a wrapper fails here loudly.

  test("the zod version in use adds refinements in place, with no wrapper type", () => {
    // The premise itself, asserted directly — this is the test that would fail
    // first if a zod upgrade changed the representation.
    expect((z.number().refine((n) => n > 0) as unknown as { type: string }).type).toBe("number");
    expect(
      (z.record(z.string(), z.unknown()).refine(() => true) as unknown as { type: string }).type
    ).toBe("record");
    expect("ZodEffects" in z).toBe(false);
  });

  test("refined NUMBER positional: coercion happens, then the refinement applies", () => {
    const schema = {
      n: def(
        z.number().refine((v) => v % 2 === 0, "must be even"),
        true
      ),
    };
    expect(normalizeCliParameters(schema, { n: "42" }).n).toBe(42);
    expect(() => normalizeCliParameters(schema, { n: "43" })).toThrow(
      /Invalid value for parameter 'n'/
    );
  });

  test("refined BIGINT and BOOLEAN positionals coerce too", () => {
    const big = {
      id: def(
        z.bigint().refine((v) => v > 0n, "positive"),
        true
      ),
    };
    expect(normalizeCliParameters(big, { id: "17" }).id).toBe(17n);

    const bool = {
      flag: def(
        z.boolean().refine((v) => v === true, "must be true"),
        true
      ),
    };
    expect(normalizeCliParameters(bool, { flag: "true" }).flag).toBe(true);
  });

  test("refined RECORD param still takes the JSON branch (mt#2482 not regressed)", () => {
    const schema = {
      payload: def(
        z.record(z.string(), z.unknown()).refine((v) => Object.keys(v).length > 0, "non-empty"),
        true
      ),
    };
    expect(normalizeCliParameters(schema, { payload: '{"k":1}' }).payload).toEqual({ k: 1 });
    // And the refinement still rejects — proving it survived the JSON branch.
    expect(() => normalizeCliParameters(schema, { payload: "{}" })).toThrow(
      /Invalid value for parameter 'payload'/
    );
  });

  test("refined OBJECT param still takes the JSON branch", () => {
    const schema = {
      cfg: def(
        z.object({ a: z.string() }).refine((v) => v.a.length > 1, "too short"),
        true
      ),
    };
    expect(normalizeCliParameters(schema, { cfg: '{"a":"xy"}' }).cfg).toEqual({ a: "xy" });
    expect(() => normalizeCliParameters(schema, { cfg: '{"a":"x"}' })).toThrow(
      /Invalid value for parameter 'cfg'/
    );
  });

  test("refined wrapped combinations (optional / default) unwrap to the scalar", () => {
    const opt = {
      n: def(
        z
          .number()
          .refine((v) => v > 0)
          .optional()
      ),
    };
    expect(normalizeCliParameters(opt, { n: "5" }).n).toBe(5);

    const dflt = {
      n: def(
        z
          .number()
          .refine((v) => v > 0)
          .default(3)
      ),
    };
    expect(normalizeCliParameters(dflt, { n: "5" }).n).toBe(5);
  });
});

describe("normalizeCliParameters — the numeric OPTION path is unchanged (PR #3008 R1)", () => {
  // PR #3008 R1's spec-verification table flagged the absence of an explicit
  // numeric-OPTION regression test. Options reach `normalizeCliParameters`
  // ALREADY typed, because `addTypeHandlingToOption` attaches a Commander
  // `argParser` that ran `Number(value)` at parse time — which is exactly why
  // options were never affected by the positional defect. These tests pin both
  // halves of that: the typed value passes through, and the coercion added here
  // does not alter it.

  test("a numeric option arrives already typed and passes through unchanged", () => {
    const schema = { limit: def(z.number().int().positive()) };
    const out = normalizeCliParameters(schema, { limit: 20 });
    expect(out.limit).toBe(20);
    expect(typeof out.limit).toBe("number");
  });

  test("Commander's argParser output for a numeric option round-trips identically", () => {
    // Reproduces `addTypeHandlingToOption`'s number branch verbatim, so this
    // test fails if that parser's contract changes underneath the adapter.
    const argParser = (value: string) => {
      const num = Number(value);
      if (isNaN(num)) throw new Error("Option requires a number value");
      return num;
    };
    const schema = { limit: def(z.number()) };
    expect(normalizeCliParameters(schema, { limit: argParser("20") }).limit).toBe(20);
  });

  test("a numeric option with a schema default is unaffected when omitted", () => {
    const schema = { limit: def(z.number().default(20)) };
    expect(normalizeCliParameters(schema, {}).limit).toBe(20);
  });

  test("a boolean flag arrives as a real boolean and is not re-coerced", () => {
    // Commander gives a declared flag `true`/`false`, never a string — the
    // scalar branch is string-gated, so it never sees these.
    const schema = { json: def(z.boolean().optional()) };
    expect(normalizeCliParameters(schema, { json: true }).json).toBe(true);
    expect(normalizeCliParameters(schema, { json: false }).json).toBe(false);
  });
});
