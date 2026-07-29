/**
 * Unit tests for the Postgres text-safety sanitizer (mt#3278).
 *
 * Every NUL in this file is built with `String.fromCharCode(0)` — never written
 * as an escape. A literal NUL in a source file makes git treat it as binary and
 * is blocked by the pre-commit guard (mt#1824), and an escape written through a
 * JSON-parameterized tool becomes a literal NUL on disk (mem#401). Both hazards
 * fired during this task's own implementation.
 */
import { describe, expect, test } from "bun:test";

import {
  POSTGRES_UNSAFE_REPLACEMENT,
  hasPostgresUnsafeCodepoint,
  sanitizeForPostgres,
  sanitizeForPostgresDeep,
} from "./postgres-text-safety";

const NUL = String.fromCharCode(0);
const FFFD = String.fromCharCode(0xfffd);

describe("sanitizeForPostgres", () => {
  test("replaces a NUL with the replacement character", () => {
    expect(sanitizeForPostgres(`a${NUL}b`)).toBe(`a${FFFD}b`);
  });

  test("replaces every occurrence, not just the first", () => {
    expect(sanitizeForPostgres(`${NUL}a${NUL}${NUL}b`)).toBe(`${FFFD}a${FFFD}${FFFD}b`);
  });

  test("returns the input untouched when there is nothing to replace", () => {
    const clean = "no control characters here";
    expect(sanitizeForPostgres(clean)).toBe(clean);
  });

  test("preserves other control characters, which Postgres CAN store", () => {
    // Only U+0000 is unrepresentable. Over-sanitizing would corrupt ordinary
    // transcript content — newlines and tabs are everywhere in tool output.
    const withControls = "line1\nline2\tend";
    expect(sanitizeForPostgres(withControls)).toBe(withControls);
  });

  test("the exported replacement is U+FFFD", () => {
    expect(POSTGRES_UNSAFE_REPLACEMENT).toBe(FFFD);
    expect(POSTGRES_UNSAFE_REPLACEMENT.codePointAt(0)).toBe(0xfffd);
  });
});

describe("hasPostgresUnsafeCodepoint", () => {
  test("detects a NUL", () => {
    expect(hasPostgresUnsafeCodepoint(`x${NUL}`)).toBe(true);
  });

  test("does not fire on clean text", () => {
    expect(hasPostgresUnsafeCodepoint("clean")).toBe(false);
  });
});

describe("sanitizeForPostgresDeep", () => {
  test("sanitizes nested object values and reports the count", () => {
    const input = {
      type: "assistant",
      message: { content: [{ type: "text", text: `before${NUL}after` }] },
    };
    const { value, replaced } = sanitizeForPostgresDeep(input);

    expect(replaced).toBe(1);
    expect(value.message.content[0]?.text).toBe(`before${FFFD}after`);
  });

  test("sanitizes object KEYS, not only values", () => {
    // A key carrying a NUL fails the insert exactly like a value does.
    const input = { [`bad${NUL}key`]: "v" };
    const { value, replaced } = sanitizeForPostgresDeep(input);

    expect(replaced).toBe(1);
    expect(Object.keys(value)).toEqual([`bad${FFFD}key`]);
  });

  // PR #2373 R1: sanitizing keys can map two distinct keys onto one. Silently
  // overwriting is the exact failure shape this module exists to remove, so the
  // collision is counted and the first value is kept.
  test("reports a key collision instead of silently dropping a value", () => {
    const input = { [`a${NUL}`]: "first", [`a${FFFD}`]: "second" };
    const { value, replaced, keyCollisions } = sanitizeForPostgresDeep(input);

    expect(replaced).toBe(1);
    expect(keyCollisions).toBe(1);
    expect(Object.keys(value)).toEqual([`a${FFFD}`]);
    expect(value[`a${FFFD}`]).toBe("first");
  });

  test("reports zero collisions on ordinary content", () => {
    expect(sanitizeForPostgresDeep({ a: `x${NUL}`, b: "y" }).keyCollisions).toBe(0);
  });

  test("counts every replaced codepoint across the whole structure", () => {
    const input = { a: `${NUL}${NUL}`, b: [`${NUL}`, "clean"], c: { d: `x${NUL}` } };
    expect(sanitizeForPostgresDeep(input).replaced).toBe(4);
  });

  test("preserves structure, types, and non-string leaves", () => {
    const input = { n: 42, b: true, nil: null, arr: [1, "two", false], nested: { deep: "ok" } };
    const { value, replaced } = sanitizeForPostgresDeep(input);

    expect(replaced).toBe(0);
    expect(value).toEqual(input);
  });

  test("returns the SAME reference when nothing changed", () => {
    // The clean path is overwhelmingly the common one — a transcript sweep runs
    // this over every line of every session, so it must not clone the world.
    const input = { a: "clean", nested: { b: [1, 2, 3] } };
    const { value } = sanitizeForPostgresDeep(input);
    expect(value).toBe(input);
  });

  test("does not mutate the input", () => {
    const input = { text: `a${NUL}b` };
    const { value } = sanitizeForPostgresDeep(input);

    expect(input.text).toBe(`a${NUL}b`);
    expect(value.text).toBe(`a${FFFD}b`);
    expect(value).not.toBe(input);
  });

  test("handles a bare string at the top level", () => {
    expect(sanitizeForPostgresDeep(`a${NUL}b`).value).toBe(`a${FFFD}b`);
  });

  test("handles a top-level array", () => {
    const { value, replaced } = sanitizeForPostgresDeep([`a${NUL}`, "b"]);
    expect(replaced).toBe(1);
    expect(value).toEqual([`a${FFFD}`, "b"]);
  });

  test("survives the real shape that caused mt#3278", () => {
    // A transcript line whose `signature` field carries the escape — the shape
    // observed in all seven poisoned local conversations, which arrives here as
    // a real U+0000 because JSON.parse already decoded the escape.
    const line = JSON.parse(`{"type":"assistant","signature":"sig\\u0000end","uuid":"u1"}`) as {
      signature: string;
    };
    expect(line.signature.includes(NUL)).toBe(true);

    const { value, replaced } = sanitizeForPostgresDeep(line);
    expect(replaced).toBe(1);
    expect(value.signature).toBe(`sig${FFFD}end`);
    // The decisive property: what goes to the driver no longer contains the
    // escape Postgres rejects.
    expect(JSON.stringify(value).includes("u0000")).toBe(false);
  });
});
