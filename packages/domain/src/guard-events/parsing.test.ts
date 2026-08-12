import { describe, test, expect } from "bun:test";
import {
  computeDedupeKey,
  canonicalizeForHash,
  resolveTailStart,
  splitCompleteLinesAndOffset,
  parseDisconnectLogArray,
  extractPromotedFields,
} from "./parsing";

describe("computeDedupeKey", () => {
  test("is deterministic for the same stream + content", () => {
    const a = computeDedupeKey("wall-of-text", '{"a":1}');
    const b = computeDedupeKey("wall-of-text", '{"a":1}');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test("differs when the stream name differs (same content)", () => {
    const a = computeDedupeKey("wall-of-text", '{"a":1}');
    const b = computeDedupeKey("silent-stretch", '{"a":1}');
    expect(a).not.toBe(b);
  });

  test("differs when the content differs (same stream)", () => {
    const a = computeDedupeKey("wall-of-text", '{"a":1}');
    const b = computeDedupeKey("wall-of-text", '{"a":2}');
    expect(a).not.toBe(b);
  });
});

const SAMPLE_TIMESTAMP = "2026-08-12T00:00:00.000Z";

describe("canonicalizeForHash", () => {
  test("produces the same output regardless of key order", () => {
    const a = canonicalizeForHash({ timestamp: "t", serverName: "s", kind: "k", cause: "c" });
    const b = canonicalizeForHash({ cause: "c", kind: "k", serverName: "s", timestamp: "t" });
    expect(a).toBe(b);
  });

  test("sorts keys recursively in nested objects", () => {
    const a = canonicalizeForHash({ outer: { z: 1, a: 2 } });
    const b = canonicalizeForHash({ outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });

  test("preserves array element order (order is semantic for arrays)", () => {
    const a = canonicalizeForHash({ list: [1, 2, 3] });
    const b = canonicalizeForHash({ list: [3, 2, 1] });
    expect(a).not.toBe(b);
  });

  test("feeding canonicalized output through computeDedupeKey is stable across key reorderings", () => {
    const e1 = {
      timestamp: SAMPLE_TIMESTAMP,
      serverName: "S",
      kind: "disconnect",
      cause: "c",
    };
    const e2 = {
      cause: "c",
      kind: "disconnect",
      serverName: "S",
      timestamp: SAMPLE_TIMESTAMP,
    };
    const k1 = computeDedupeKey("mcp-disconnect-log", canonicalizeForHash(e1));
    const k2 = computeDedupeKey("mcp-disconnect-log", canonicalizeForHash(e2));
    expect(k1).toBe(k2);
  });
});

describe("resolveTailStart", () => {
  test("returns the prior offset when it still fits inside the file", () => {
    expect(resolveTailStart(1000, 500)).toBe(500);
  });

  test("resets to 0 when there is no prior offset", () => {
    expect(resolveTailStart(1000, undefined)).toBe(0);
  });

  test("resets to 0 when the prior offset exceeds the current file size (rotation/truncation)", () => {
    expect(resolveTailStart(100, 500)).toBe(0);
  });

  test("resets to 0 for a negative offset", () => {
    expect(resolveTailStart(100, -1)).toBe(0);
  });

  test("prior offset exactly equal to file size is valid (no new content, not a reset)", () => {
    expect(resolveTailStart(100, 100)).toBe(100);
  });
});

describe("splitCompleteLinesAndOffset", () => {
  test("splits complete lines and advances the offset past them", () => {
    const { lines, newOffset } = splitCompleteLinesAndOffset('{"a":1}\n{"a":2}\n', 0);
    expect(lines).toEqual(['{"a":1}', '{"a":2}']);
    expect(newOffset).toBe(Buffer.byteLength('{"a":1}\n{"a":2}\n', "utf-8"));
  });

  test("does NOT consume a trailing partial line with no newline yet", () => {
    const { lines, newOffset } = splitCompleteLinesAndOffset('{"a":1}\n{"a":2', 0);
    expect(lines).toEqual(['{"a":1}']);
    expect(newOffset).toBe(Buffer.byteLength('{"a":1}\n', "utf-8"));
  });

  test("returns no lines and an unchanged offset when there is no complete line at all", () => {
    const { lines, newOffset } = splitCompleteLinesAndOffset('{"a":1', 42);
    expect(lines).toEqual([]);
    expect(newOffset).toBe(42);
  });

  test("offset is relative to fromByte, not 0", () => {
    const { newOffset } = splitCompleteLinesAndOffset('{"a":1}\n', 1000);
    expect(newOffset).toBe(1000 + Buffer.byteLength('{"a":1}\n', "utf-8"));
  });

  test("skips blank lines", () => {
    const { lines } = splitCompleteLinesAndOffset('{"a":1}\n\n{"a":2}\n', 0);
    expect(lines).toEqual(['{"a":1}', '{"a":2}']);
  });
});

describe("parseDisconnectLogArray", () => {
  test("parses plain JSONL content (no legacy array head)", () => {
    const raw =
      '{"timestamp":"t1","serverName":"S","kind":"disconnect","cause":"c1"}\n{"timestamp":"t2","serverName":"S","kind":"reconnect","cause":"c2"}\n';
    const elements = parseDisconnectLogArray(raw);
    expect(elements).toHaveLength(2);
    expect((elements[0] as { cause: string }).cause).toBe("c1");
  });

  test("parses the legacy pretty-printed array head, then the trailing JSONL", () => {
    const legacy = JSON.stringify(
      [
        { timestamp: "t1", serverName: "S", kind: "disconnect", cause: "legacy1" },
        { timestamp: "t2", serverName: "S", kind: "reconnect", cause: "legacy2" },
      ],
      null,
      2
    );
    const raw = `${legacy}\n{"timestamp":"t3","serverName":"S","kind":"disconnect","cause":"tail1"}\n`;
    const elements = parseDisconnectLogArray(raw) as Array<{ cause: string }>;
    expect(elements.map((e) => e.cause)).toEqual(["legacy1", "legacy2", "tail1"]);
  });

  test("skips malformed lines without throwing", () => {
    const raw =
      '{"timestamp":"t1","serverName":"S","kind":"disconnect","cause":"c1"}\nnot json\n{"timestamp":"t2","serverName":"S","kind":"disconnect","cause":"c2"}\n';
    const elements = parseDisconnectLogArray(raw) as Array<{ cause: string }>;
    expect(elements.map((e) => e.cause)).toEqual(["c1", "c2"]);
  });

  test("empty input yields an empty array", () => {
    expect(parseDisconnectLogArray("")).toEqual([]);
  });
});

describe("extractPromotedFields", () => {
  test("reads fire-log-shaped fields (guardName/sessionId/decision/event/durationMs)", () => {
    const record = {
      timestamp: "2026-08-12T17:12:23.632Z",
      guardName: "block-secret-file-read",
      event: "PreToolUse",
      decision: "allow",
      durationMs: 1,
      sessionId: "abc-123",
    };
    const fields = extractPromotedFields(record, undefined);
    expect(fields.guardName).toBe("block-secret-file-read");
    expect(fields.sessionId).toBe("abc-123");
    expect(fields.decision).toBe("allow");
    expect(fields.event).toBe("PreToolUse");
    expect(fields.durationMs).toBe(1);
    expect(fields.occurredAt?.toISOString()).toBe("2026-08-12T17:12:23.632Z");
  });

  test("reads snake_case field variants (session_id/duration_ms)", () => {
    const record = { session_id: "xyz", duration_ms: 42, timestamp: SAMPLE_TIMESTAMP };
    const fields = extractPromotedFields(record, undefined);
    expect(fields.sessionId).toBe("xyz");
    expect(fields.durationMs).toBe(42);
  });

  test("falls back to the static guard name only when the record carries none", () => {
    const withStatic = extractPromotedFields({ matches: [] }, "wall-of-text");
    expect(withStatic.guardName).toBe("wall-of-text");

    const perRecordWins = extractPromotedFields(
      { guardName: "record-level-guard" },
      "static-fallback-guard"
    );
    expect(perRecordWins.guardName).toBe("record-level-guard");
  });

  test("mcp-disconnect-log element (kind, no guardName/decision/durationMs)", () => {
    const record = {
      timestamp: SAMPLE_TIMESTAMP,
      serverName: "S",
      kind: "disconnect",
      cause: "c",
    };
    const fields = extractPromotedFields(record, undefined);
    expect(fields.guardName).toBeNull();
    expect(fields.decision).toBeNull();
    expect(fields.durationMs).toBeNull();
    expect(fields.event).toBe("disconnect");
  });

  test("malformed/non-object record yields all-null fields, still honoring the static guard name", () => {
    expect(extractPromotedFields(null, "some-guard")).toEqual({
      occurredAt: null,
      sessionId: null,
      guardName: "some-guard",
      decision: null,
      event: null,
      durationMs: null,
    });
  });

  test("missing/invalid timestamp yields a null occurredAt rather than throwing", () => {
    expect(extractPromotedFields({ timestamp: "not-a-date" }, undefined).occurredAt).toBeNull();
    expect(extractPromotedFields({}, undefined).occurredAt).toBeNull();
  });
});
