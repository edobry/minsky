/**
 * Unit tests for `boundToolResponseText` (mt#4749).
 *
 * Filesystem fully injected (`ResponseSizeGuardDeps`) rather than a real
 * tmpdir — `custom/no-real-fs-in-tests` forbids `node:fs` in test files, and
 * an in-memory fake asserts exactly what got written and where.
 */

import { describe, test, expect } from "bun:test";
import {
  boundToolResponseText,
  MAX_TOOL_RESPONSE_TEXT_BYTES,
  type ResponseSizeGuardDeps,
} from "./response-size-guard";

/** An in-memory fake standing in for the real fs seam. */
function fakeFs(): {
  deps: ResponseSizeGuardDeps;
  dirsCreated: string[];
  filesWritten: Record<string, string>;
} {
  const dirsCreated: string[] = [];
  const filesWritten: Record<string, string> = {};
  return {
    dirsCreated,
    filesWritten,
    deps: {
      stateDir: "/fake-state",
      mkdirSync: ((dir: string) => {
        dirsCreated.push(dir);
      }) as unknown as ResponseSizeGuardDeps["mkdirSync"],
      writeFileSync: ((p: string, c: string) => {
        filesWritten[p] = c;
      }) as unknown as ResponseSizeGuardDeps["writeFileSync"],
    },
  };
}

describe("boundToolResponseText (mt#4749)", () => {
  test("returns small text unchanged — no spool, no fs write", () => {
    const fake = fakeFs();
    const out = boundToolResponseText("hello", "greet", fake.deps);
    expect(out).toBe("hello");
    expect(Object.keys(fake.filesWritten)).toHaveLength(0);
  });

  test("AT1/AT2: an oversized response is spooled and replaced with a bounded pointer, never dropped", () => {
    const fake = fakeFs();
    const hugeText = "x".repeat(MAX_TOOL_RESPONSE_TEXT_BYTES + 1000);

    const out = boundToolResponseText(hugeText, "forge_ci_run_view_log", fake.deps);

    expect(out.length).toBeLessThan(MAX_TOOL_RESPONSE_TEXT_BYTES);
    expect(out).toContain("TRUNCATED");
    expect(out).toContain("mt#4749");
    expect(out).toContain("forge_ci_run_view_log");
    // The tool call itself is not misrepresented as a failure.
    expect(out).toContain("succeeded");

    expect(Object.keys(fake.filesWritten)).toHaveLength(1);
    const [spooledPath] = Object.keys(fake.filesWritten);
    expect(out).toContain(spooledPath as string);
    expect(fake.filesWritten[spooledPath as string]).toBe(hugeText);
  });

  test("a response exactly at the cap is returned unchanged (boundary)", () => {
    const fake = fakeFs();
    const text = "y".repeat(MAX_TOOL_RESPONSE_TEXT_BYTES);
    const out = boundToolResponseText(text, "some_tool", fake.deps);
    expect(out).toBe(text);
    expect(Object.keys(fake.filesWritten)).toHaveLength(0);
  });

  test("one byte over the cap trips the bound", () => {
    const fake = fakeFs();
    const text = "y".repeat(MAX_TOOL_RESPONSE_TEXT_BYTES + 1);
    const out = boundToolResponseText(text, "some_tool", fake.deps);
    expect(out).not.toBe(text);
    expect(out).toContain("TRUNCATED");
  });

  test("sanitizes the tool name in the spooled filename", () => {
    const fake = fakeFs();
    const hugeText = "z".repeat(MAX_TOOL_RESPONSE_TEXT_BYTES + 1);
    boundToolResponseText(hugeText, "forge.ci_run_view_log", fake.deps);
    const [spooledPath] = Object.keys(fake.filesWritten);
    expect(spooledPath).not.toContain(".ci_run_view_log");
    expect(fake.dirsCreated[0]).toContain("mcp-oversized-tool-responses");
  });
});
