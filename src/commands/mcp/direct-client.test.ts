/**
 * Argument-marshalling tests for `minsky mcp call --arg key=value` (mt#4459).
 *
 * The originating defect: `arg.split("=", 2)` reads like Python's
 * `str.split(sep, maxsplit)` (which caps the number of SPLITS and keeps the
 * remainder) but JavaScript's `String.prototype.split` caps the LENGTH OF THE
 * RESULT ARRAY and DISCARDS the rest. So any value containing a further `=`
 * was silently truncated at the second one and written as a success.
 */
import { describe, expect, test } from "bun:test";
import { parseToolArgs } from "./direct-client";

describe("parseToolArgs", () => {
  test("splits on the FIRST separator only and preserves the remainder", () => {
    // The regression: this returned { content: "a" } before mt#4459.
    expect(parseToolArgs(["content=a=b=c"])).toEqual({ content: "a=b=c" });
  });

  test("preserves a realistic payload containing separators, newlines and quotes", () => {
    const value = ["line one --arg 'key=value'", 'line "two" with an = sign', ""].join("\n");
    const parsed = parseToolArgs([`content=${value}`]);
    expect(parsed.content).toBe(value);
  });

  test("handles the ordinary single-separator case", () => {
    expect(parseToolArgs(["taskId=mt#4459"])).toEqual({ taskId: "mt#4459" });
  });

  test("accepts multiple pairs and keeps each value whole", () => {
    expect(parseToolArgs(["a=1=2", "b=plain"])).toEqual({ a: "1=2", b: "plain" });
  });

  test("keeps an empty value rather than dropping the key", () => {
    expect(parseToolArgs(["content="])).toEqual({ content: "" });
  });

  test("skips a malformed entry that carries no separator", () => {
    expect(parseToolArgs(["noseparator"])).toEqual({});
  });

  test("does not treat a leading separator as a key", () => {
    expect(parseToolArgs(["=orphan"])).toEqual({});
  });
});
