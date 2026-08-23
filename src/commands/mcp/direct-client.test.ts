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
import { join } from "path";
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

  // Fails closed rather than skipping: a dropped argument is the same silent-success
  // failure mode as the truncation this function exists to fix.
  test("throws, naming the argument, when there is no separator", () => {
    expect(() => parseToolArgs(["noseparator"])).toThrow(/Malformed --arg 'noseparator'/);
  });

  test("throws, naming the argument, when the parameter name is empty", () => {
    expect(() => parseToolArgs(["=orphan"])).toThrow(/Malformed --arg '=orphan'/);
  });

  test("reports the offending entry even when earlier entries are well formed", () => {
    expect(() => parseToolArgs(["good=1", "bad"])).toThrow(/Malformed --arg 'bad'/);
  });
});

/**
 * End-to-end round trip through the real `minsky mcp call` path (mt#4459 acceptance test).
 *
 * Unit-testing `parseToolArgs` proves the parser; it does not prove that a value survives
 * the whole client path into the tool's arguments. This spawns the actual CLI against
 * `debug_echo` — a read-only tool that reflects its input back — and asserts byte equality
 * on a payload carrying two separators, a newline and both quote characters.
 */
describe("mcp call --arg round trip", () => {
  const PAYLOAD = ["alpha=beta=gamma", "second \"line\" with 'quotes'", "trailing"].join("\n");

  test("a value with separators, newlines and quotes reaches the tool intact", async () => {
    const cliEntry = join(import.meta.dir, "..", "..", "cli.ts");
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        cliEntry,
        "mcp",
        "call",
        "debug_echo",
        "--timeout",
        "90",
        "--arg",
        `message=${PAYLOAD}`,
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;

    // Surface the child's stderr on failure — a bare "no match" here is otherwise
    // indistinguishable from the server failing to start.
    const jsonStart = stdout.indexOf("{");
    expect(
      jsonStart,
      `no JSON in stdout.\nstdout:\n${stdout}\nstderr:\n${stderr}`
    ).toBeGreaterThanOrEqual(0);

    const envelope = JSON.parse(stdout.slice(jsonStart));
    const inner = JSON.parse(envelope.content[0].text);
    expect(inner.echo.message).toBe(PAYLOAD);
  }, 120_000);
});
