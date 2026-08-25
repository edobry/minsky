/**
 * Tests for the disconnect-log normalizer (mt#4558).
 *
 * All of these exercise the PURE transform — `normalize()` takes text and
 * returns text, so nothing here touches a real file. That split is why the
 * script keeps its IO in `main()`: the interesting behaviour is the format
 * conversion, and it should be testable without a tmpdir.
 */
import { describe, test, expect } from "bun:test";
import { normalize, countNonParsingLines, findMatchingBracket } from "./normalize-disconnect-log";

const NEWLINE = String.fromCharCode(10);

const LEGACY_RECORDS = [
  { timestamp: "2026-05-08T19:45:09.737Z", serverName: "srv", kind: "reconnect", cause: "unknown" },
  {
    timestamp: "2026-05-08T20:17:53.199Z",
    serverName: "srv",
    kind: "disconnect",
    cause: "stdin_close",
  },
];

const JSONL_RECORDS = [
  { timestamp: "2026-05-08T22:00:22.113Z", serverName: "srv", kind: "process_start", pid: 91211 },
  { timestamp: "2026-05-08T22:00:22.129Z", serverName: "srv", kind: "reconnect", cause: "unknown" },
];

function jsonlOf(records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join(NEWLINE);
}

describe("normalize (mt#4558)", () => {
  test("converts a legacy array head to JSONL and preserves the existing JSONL tail", () => {
    const hybrid = `${JSON.stringify(LEGACY_RECORDS, null, 2)}${NEWLINE}${jsonlOf(JSONL_RECORDS)}${NEWLINE}`;
    // Precondition: the fixture really is non-uniform, or the test proves nothing.
    expect(countNonParsingLines(hybrid)).toBeGreaterThan(0);

    const result = normalize(hybrid);
    expect(result.alreadyUniform).toBe(false);
    expect(result.convertedRecords).toBe(2);
    expect(result.existingJsonlLines).toBe(2);

    const out = result.content ?? "";
    expect(countNonParsingLines(out)).toBe(0);

    // Every record survives, in order, with its fields intact.
    const parsed = out
      .split(NEWLINE)
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l));
    expect(parsed.length).toBe(4);
    expect(parsed[0]?.cause).toBe("unknown");
    expect(parsed[1]?.cause).toBe("stdin_close");
    expect(parsed[2]?.pid).toBe(91211);
    expect(parsed[3]?.kind).toBe("reconnect");
  });

  test("handles the GLUED seam — the shape that actually shipped before mt#4481", () => {
    // No separator between `]` and the first append. This is what the real file
    // looked like from 2026-05-08 until mt#4481 split the line.
    const glued = `${JSON.stringify(LEGACY_RECORDS, null, 2)}${jsonlOf(JSONL_RECORDS)}${NEWLINE}`;
    expect(glued).toContain("]{");

    const result = normalize(glued);
    expect(result.alreadyUniform).toBe(false);
    expect(result.convertedRecords).toBe(2);

    const out = result.content ?? "";
    expect(out).not.toContain("]{");
    expect(countNonParsingLines(out)).toBe(0);
    expect(out.split(NEWLINE).filter((l) => l.trim() !== "").length).toBe(4);
  });

  test("an already-uniform file is a no-op, not a rewrite", () => {
    const uniform = `${jsonlOf(JSONL_RECORDS)}${NEWLINE}`;
    const result = normalize(uniform);
    expect(result.alreadyUniform).toBe(true);
    expect(result.convertedRecords).toBe(0);
    expect(result.existingJsonlLines).toBe(2);
    // No content means main() writes nothing — idempotence comes from here.
    expect(result.content).toBeUndefined();
  });

  test("an array with no JSONL tail still ends with a trailing newline", () => {
    // Trailing newline is the whole point: without it the NEXT append glues
    // onto the last record, which is the mt#4481 defect in a new place.
    const arrayOnly = JSON.stringify(LEGACY_RECORDS, null, 2);
    const result = normalize(arrayOnly);
    expect(result.alreadyUniform).toBe(false);
    expect(result.convertedRecords).toBe(2);
    expect(result.content?.endsWith(NEWLINE)).toBe(true);
    expect(countNonParsingLines(result.content ?? "")).toBe(0);
  });

  test("an unterminated array is left alone rather than guessed at", () => {
    const truncated = `[${NEWLINE}  {"a": 1},${NEWLINE}  {"b": 2}`;
    const result = normalize(truncated);
    // Reported as already-uniform so `--execute` refuses to rewrite a file it
    // cannot fully parse — losing records to a clever guess is worse than a no-op.
    expect(result.alreadyUniform).toBe(true);
    expect(result.content).toBeUndefined();
  });
});

describe("countNonParsingLines (mt#4558)", () => {
  test("counts the pretty-printed array's lines and ignores blanks", () => {
    const hybrid = `${JSON.stringify(LEGACY_RECORDS, null, 2)}${NEWLINE}${jsonlOf(JSONL_RECORDS)}${NEWLINE}`;
    // The array spans multiple lines, none of which parse alone; the two JSONL
    // lines do. This is the check SC2 mandates over `jq -s`, which would report
    // the hybrid as fine.
    const bad = countNonParsingLines(hybrid);
    expect(bad).toBeGreaterThan(0);
    expect(bad).toBe(hybrid.split(NEWLINE).filter((l) => l.trim() !== "").length - 2);
  });

  test("returns zero for uniform JSONL", () => {
    expect(countNonParsingLines(`${jsonlOf(JSONL_RECORDS)}${NEWLINE}`)).toBe(0);
  });
});

describe("findMatchingBracket (mt#4558)", () => {
  test("ignores brackets inside string literals", () => {
    // A cause or stderrTail can legitimately contain a bracket; a naive scan
    // would end the array early and silently drop every record after it.
    const source = `[{"note": "has ] a bracket"}, {"b": 2}]`;
    const end = findMatchingBracket(source, 0);
    expect(end).toBe(source.length - 1);
    expect(JSON.parse(source.slice(0, end + 1))).toHaveLength(2);
  });

  test("ignores a bracket that is escaped inside a string", () => {
    const source = `[{"note": "escaped quote \\" then ] bracket"}]`;
    const end = findMatchingBracket(source, 0);
    expect(end).toBe(source.length - 1);
    expect(JSON.parse(source.slice(0, end + 1))).toHaveLength(1);
  });

  test("returns -1 when the array never closes", () => {
    expect(findMatchingBracket(`[{"a": 1}`, 0)).toBe(-1);
  });
});
