import { describe, test, expect } from "bun:test";
import { recordClientFailure, type ClientFailureRecord } from "./failure-log";

/**
 * mt#4828 SC4 — the client's half of a daemon death, recorded durably.
 *
 * The filesystem is injected rather than real (`custom/no-real-fs-in-tests`),
 * which is also what lets the never-throws property be asserted directly: a
 * real fs makes "the disk write failed" awkward to provoke, while an injected
 * `appendFileSync` can simply throw.
 */
describe("recordClientFailure", () => {
  interface Write {
    file: string;
    data: string;
  }

  function capture() {
    const writes: Write[] = [];
    const appendFileSync = ((file: string, data: string) => {
      writes.push({ file, data });
    }) as unknown as typeof import("node:fs").appendFileSync;
    /** The single expected write, failing loudly rather than via `!`. */
    const only = (): Write => {
      if (writes.length !== 1) {
        throw new Error(`expected exactly one write, got ${writes.length}`);
      }
      return writes[0] as Write;
    };
    return { writes, appendFileSync, only };
  }

  const INPUT = {
    failureKind: "connection-lost" as const,
    method: "tools/call",
    toolName: "session_commit",
    error: "The socket connection was closed unexpectedly",
  };

  test("appends one JSONL line to the ACTIVE disconnect log", () => {
    const { writes, appendFileSync, only } = capture();

    recordClientFailure(INPUT, {
      appendFileSync,
      stateDir: "/fake-state",
      nowMs: Date.UTC(2026, 7, 31, 20, 24, 19),
    });

    expect(writes).toHaveLength(1);
    // Same file the daemon writes, so the log→system_events pipeline mt#4654
    // is repairing carries both halves of one event. A rolled segment is the
    // daemon's business; the shim only ever appends to the active path.
    expect(only().file).toBe("/fake-state/mcp-disconnect-log.json");
    expect(only().data.endsWith("\n")).toBe(true);
    expect(only().data.trimEnd()).not.toContain("\n");
  });

  test("the record carries the fields a cadence query needs", () => {
    const { appendFileSync, only } = capture();

    recordClientFailure(INPUT, {
      appendFileSync,
      stateDir: "/fake-state",
      nowMs: Date.UTC(2026, 7, 31, 20, 24, 19),
    });

    const record = JSON.parse(only().data) as ClientFailureRecord;
    // `kind` is deliberately NOT "disconnect": disconnect-event-sweep.ts
    // filters on that exact value, so this record is inert for every current
    // reader instead of inflating the projection.
    expect(record.kind).toBe("client_failure");
    expect(record.failureKind).toBe("connection-lost");
    expect(record.method).toBe("tools/call");
    expect(record.toolName).toBe("session_commit");
    expect(record.error).toBe("The socket connection was closed unexpectedly");
    // Timestamp is the correlation key against the daemon-side row.
    expect(record.timestamp).toBe("2026-08-31T20:24:19.000Z");
  });

  test("omits toolName rather than emitting null when there is none", () => {
    const { appendFileSync, only } = capture();

    recordClientFailure(
      { failureKind: "unreachable", method: "initialize", error: "ECONNREFUSED" },
      { appendFileSync, stateDir: "/fake-state", nowMs: 0 }
    );

    const record = JSON.parse(only().data) as ClientFailureRecord;
    // A projection over a key the source lacks manufactures a type-valid null
    // that reads as data (claim-confidence.mdc); absent is the honest shape.
    expect("toolName" in record).toBe(false);
  });

  test("never throws when the write fails", () => {
    const appendFileSync = (() => {
      throw new Error("EACCES: permission denied");
    }) as unknown as typeof import("node:fs").appendFileSync;

    // This runs inside the caller's `catch`, while it is composing the
    // JSON-RPC error the client will receive. Throwing here would replace a
    // real, classified daemon failure with an unrelated filesystem error.
    expect(() =>
      recordClientFailure(INPUT, { appendFileSync, stateDir: "/fake-state", nowMs: 0 })
    ).not.toThrow();
  });
});
