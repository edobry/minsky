/**
 * Unit tests for `boundOversizedResponse` (mt#4749).
 *
 * The filesystem is fully injected (`ResponseBoundDeps`) rather than touching
 * a real tmpdir — `custom/no-real-fs-in-tests` forbids `node:fs` in test
 * files, and an in-memory fake is a stronger test anyway: it asserts exactly
 * what got written and where, without depending on OS temp-dir behavior.
 */

import { describe, test, expect } from "bun:test";
import { boundOversizedResponse, MAX_STDOUT_FRAME_BYTES } from "./response-bound";
import type { JsonRpcMessage } from "./protocol";

/** An in-memory fake standing in for the real fs seam. */
function fakeFs(): {
  deps: {
    mkdirSync: (dir: string, opts?: unknown) => void;
    writeFileSync: (p: string, c: string) => void;
    stateDir: string;
  };
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
      mkdirSync: (dir: string) => {
        dirsCreated.push(dir);
      },
      writeFileSync: (p: string, c: string) => {
        filesWritten[p] = c;
      },
    },
  };
}

describe("boundOversizedResponse (mt#4749)", () => {
  test("returns a small response unchanged — no spool, no fs write", () => {
    const fake = fakeFs();
    const resp: JsonRpcMessage = { jsonrpc: "2.0", id: 1, result: { ok: true } };

    const out = boundOversizedResponse(
      resp,
      fake.deps as unknown as Parameters<typeof boundOversizedResponse>[1]
    );

    expect(out).toBe(resp);
    expect(Object.keys(fake.filesWritten)).toHaveLength(0);
  });

  test("AT2: an oversized response is spooled and replaced with a structured error, never dropped", () => {
    const fake = fakeFs();
    // A synthetic oversized tool result — well past MAX_STDOUT_FRAME_BYTES,
    // mirroring the class of payload that killed the connection (a huge
    // forge_ci_run_view_log result).
    const hugeText = "x".repeat(MAX_STDOUT_FRAME_BYTES + 1000);
    const resp: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 42,
      result: { content: [{ type: "text", text: hugeText }] },
    };

    const out = boundOversizedResponse(
      resp,
      fake.deps as unknown as Parameters<typeof boundOversizedResponse>[1]
    );

    // Never a bare disconnect / dropped message — always a well-formed
    // JSON-RPC frame the client can parse.
    expect(out.jsonrpc).toBe("2.0");
    expect(out.id).toBe(42);
    expect(out.error).toBeDefined();
    expect(out.error?.message).toContain("too large");
    expect(out.error?.message).toContain("mt#4749");

    // The full content was spooled, not silently dropped.
    expect(Object.keys(fake.filesWritten)).toHaveLength(1);
    const [spooledPath] = Object.keys(fake.filesWritten);
    expect(out.error?.message).toContain(spooledPath as string);
    expect(fake.filesWritten[spooledPath as string]).toBe(JSON.stringify(resp));

    // The replacement frame itself is small — it did not just re-embed the
    // huge payload under a different key.
    expect(JSON.stringify(out).length).toBeLessThan(1000);
  });

  test("a response exactly at the cap is returned unchanged (boundary)", () => {
    const fake = fakeFs();
    // Construct a frame whose JSON.stringify length is exactly the cap.
    const overhead = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "" } }).length;
    const padLen = MAX_STDOUT_FRAME_BYTES - overhead;
    const resp: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 1,
      result: { text: "y".repeat(padLen) },
    };
    expect(JSON.stringify(resp).length).toBe(MAX_STDOUT_FRAME_BYTES);

    const out = boundOversizedResponse(
      resp,
      fake.deps as unknown as Parameters<typeof boundOversizedResponse>[1]
    );

    expect(out).toBe(resp);
    expect(Object.keys(fake.filesWritten)).toHaveLength(0);
  });

  test("one byte over the cap trips the bound", () => {
    const fake = fakeFs();
    const overhead = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "" } }).length;
    const padLen = MAX_STDOUT_FRAME_BYTES - overhead + 1;
    const resp: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 1,
      result: { text: "y".repeat(padLen) },
    };

    const out = boundOversizedResponse(
      resp,
      fake.deps as unknown as Parameters<typeof boundOversizedResponse>[1]
    );

    expect(out.error).toBeDefined();
  });

  test("preserves the original response id in the error frame, including id 0", () => {
    const fake = fakeFs();
    const hugeText = "z".repeat(MAX_STDOUT_FRAME_BYTES + 1);
    const resp: JsonRpcMessage = { jsonrpc: "2.0", id: 0, result: { text: hugeText } };

    const out = boundOversizedResponse(
      resp,
      fake.deps as unknown as Parameters<typeof boundOversizedResponse>[1]
    );

    expect(out.id).toBe(0);
  });

  test("spools under the injected state dir's oversized-responses subdirectory", () => {
    const fake = fakeFs();
    const hugeText = "w".repeat(MAX_STDOUT_FRAME_BYTES + 1);
    const resp: JsonRpcMessage = { jsonrpc: "2.0", id: 7, result: { text: hugeText } };

    boundOversizedResponse(
      resp,
      fake.deps as unknown as Parameters<typeof boundOversizedResponse>[1]
    );

    expect(fake.dirsCreated).toHaveLength(1);
    expect(fake.dirsCreated[0]).toContain("/fake-state");
    expect(fake.dirsCreated[0]).toContain("mcp-oversized-responses");
  });
});
