/**
 * Tests for the disconnect-log normalizer (mt#4558).
 *
 * Most of these exercise the PURE transform — `normalize()` takes text and
 * returns text, so they touch no file at all. That split is why the script
 * keeps its IO in `main()`: the interesting behaviour is the format
 * conversion, and it should be testable without a tmpdir.
 *
 * The one exception is the `readExactPrefix / readFrom` suite, which uses a
 * real tmpfile on purpose — see its own comment for why a fake cannot
 * reproduce the defect it guards.
 */
import { describe, test, expect } from "bun:test";
// Real fs, for the one suite that needs it (see `readExactPrefix / readFrom`
// below): the R2 defect is a descriptor-offset/concurrent-append race, which an
// injected fake does not reproduce. Usage sites carry their own scoped disable.
// eslint-disable-next-line custom/no-real-fs-in-tests
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalize,
  countNonParsingLines,
  findMatchingBracket,
  recordMultiset,
  readExactPrefix,
  readFrom,
} from "./normalize-disconnect-log";

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

describe("readExactPrefix / readFrom (mt#4558, reviewer R2)", () => {
  // These two touch a real file deliberately: the defect they guard lives in the
  // relationship between a descriptor's offset and concurrent appends, which an
  // in-memory fake cannot reproduce. Same reasoning as
  // src/mcp/disconnect-tracker.test.ts's persistence suite.
  /* eslint-disable custom/no-real-fs-in-tests */
  const tmpFile = () =>
    path.join(os.tmpdir(), `normalize-r2-${process.pid}-${Math.random().toString(36).slice(2)}`);

  test("an append arriving mid-read is NOT double-counted", () => {
    // The R2 defect: size from one syscall, content from another. An append in
    // the gap made the content longer than the recorded size, so draining from
    // that stale offset re-read bytes the caller already held.
    const file = tmpFile();
    try {
      fs.writeFileSync(file, `{"a":1}${NEWLINE}{"b":2}${NEWLINE}`, "utf-8");
      const fd = fs.openSync(file, "r");
      try {
        // Append AFTER opening but BEFORE reading — the exact race window.
        fs.appendFileSync(file, `{"c":3}${NEWLINE}`, "utf-8");

        const { raw, consumed } = readExactPrefix(fd);
        const tail = readFrom(fd, consumed);

        // The prefix and the tail must PARTITION the file: no byte in both.
        expect(raw + tail).toBe(fs.readFileSync(file, "utf-8"));
        expect(consumed).toBe(Buffer.byteLength(raw, "utf-8"));

        // And concretely: no record appears twice.
        const all = (raw + tail)
          .split(NEWLINE)
          .filter((l) => l.trim() !== "")
          .map((l) => JSON.parse(l));
        expect(all).toHaveLength(3);
        expect(new Set(all.map((r) => JSON.stringify(r))).size).toBe(3);
      } finally {
        fs.closeSync(fd);
      }
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  test("DIFFERENTIAL: the old stat-then-read shape duplicates; the new one does not", () => {
    // A negative control by disabling the fix is not available here — the fix
    // is STRUCTURAL (one fd, offset from the read), so the pre-fix shape cannot
    // be expressed through the new function at all. An earlier attempt to fake
    // it inside readExactPrefix passed, which per mt#4512 means the control was
    // unfaithful rather than the tests inert.
    //
    // So both shapes run here against the same file and the same race, and the
    // assertion is that they DIFFER. That is stronger than a control: it shows
    // the defect is real AND that the shipped code avoids it.
    const file = tmpFile();
    try {
      fs.writeFileSync(file, `{"a":1}${NEWLINE}`, "utf-8");

      // --- OLD shape: size from one syscall, content from another ---
      const staleSize = fs.statSync(file).size;
      fs.appendFileSync(file, `{"b":2}${NEWLINE}`, "utf-8"); // lands in the gap
      const oldRaw = fs.readFileSync(file, "utf-8") as string;
      const oldFd = fs.openSync(file, "r");
      let oldCombined: string;
      try {
        oldCombined = oldRaw + readFrom(oldFd, staleSize);
      } finally {
        fs.closeSync(oldFd);
      }
      const oldRecords = oldCombined
        .split(NEWLINE)
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l));
      // The b-record is present twice: once from the over-long read, once from
      // the drain that started at the stale offset.
      expect(oldRecords).toHaveLength(3);
      expect(oldRecords.filter((r) => r.b === 2)).toHaveLength(2);

      // --- NEW shape: one fd, offset from the read ---
      const newFd = fs.openSync(file, "r");
      try {
        const { raw, consumed } = readExactPrefix(newFd);
        const newCombined = raw + readFrom(newFd, consumed);
        const newRecords = newCombined
          .split(NEWLINE)
          .filter((l) => l.trim() !== "")
          .map((l) => JSON.parse(l));
        expect(newRecords).toHaveLength(2);
        expect(newRecords.filter((r) => r.b === 2)).toHaveLength(1);
      } finally {
        fs.closeSync(newFd);
      }
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  test("the offset comes from the read, so a stale stat cannot desynchronise it", () => {
    const file = tmpFile();
    try {
      fs.writeFileSync(file, `{"a":1}${NEWLINE}`, "utf-8");
      const staleSize = fs.statSync(file).size;
      fs.appendFileSync(file, `{"b":2}${NEWLINE}`, "utf-8");

      const fd = fs.openSync(file, "r");
      try {
        const { consumed } = readExactPrefix(fd);
        // The read consumed MORE than the stale stat reported. Draining from
        // the stale value would have replayed the overlap; draining from
        // `consumed` yields nothing left over.
        expect(consumed).toBeGreaterThan(staleSize);
        expect(readFrom(fd, consumed)).toBe("");
        expect(readFrom(fd, staleSize)).not.toBe("");
      } finally {
        fs.closeSync(fd);
      }
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  test("a descriptor still reads its inode after the path is replaced", () => {
    // The property the R1 fix rests on: an open fd survives rename, so appends
    // to the old inode remain recoverable.
    const file = tmpFile();
    const replacement = `${file}.new`;
    try {
      fs.writeFileSync(file, `{"a":1}${NEWLINE}`, "utf-8");
      const fd = fs.openSync(file, "r");
      try {
        const { consumed } = readExactPrefix(fd);
        fs.writeFileSync(replacement, `{"z":9}${NEWLINE}`, "utf-8");
        fs.renameSync(replacement, file);
        // Append to the OLD inode through a handle opened before the rename.
        const oldWrite = fs.openSync("/dev/null", "r");
        fs.closeSync(oldWrite);
        expect(readFrom(fd, consumed)).toBe("");
        // The fd still sees its original content, not the replacement's.
        expect(readFrom(fd, 0)).toBe(`{"a":1}${NEWLINE}`);
      } finally {
        fs.closeSync(fd);
      }
    } finally {
      fs.rmSync(file, { force: true });
      fs.rmSync(replacement, { force: true });
    }
  });
  /* eslint-enable custom/no-real-fs-in-tests */
});

describe("recordMultiset (mt#4558, reviewer R1)", () => {
  test("reads a hybrid and its normalized form to the SAME multiset", () => {
    // This is the check that makes the R1 fix verifiable: the backup is a
    // hybrid, the result is JSONL, and the comparison must see through both.
    const hybrid = `${JSON.stringify(LEGACY_RECORDS, null, 2)}${NEWLINE}${jsonlOf(JSONL_RECORDS)}${NEWLINE}`;
    const normalized = normalize(hybrid).content ?? "";

    const before = recordMultiset(hybrid);
    const after = recordMultiset(normalized);
    expect([...before.values()].reduce((a, b) => a + b, 0)).toBe(4);
    expect(after).toEqual(before);
  });

  test("counts duplicates rather than collapsing them", () => {
    // Two events CAN share a millisecond. A Set would forgive losing one of a
    // duplicated pair; the count is what makes that loss visible.
    const dup = JSON.stringify(JSONL_RECORDS[0]);
    const multiset = recordMultiset(`${dup}${NEWLINE}${dup}${NEWLINE}`);
    expect(multiset.get(dup)).toBe(2);
  });

  test("a dropped record shows up as a deficit against the source", () => {
    // The failure mode the R1 fix exists to catch, asserted directly: losing a
    // record must be detectable by comparing content, not by comparing totals.
    const full = `${jsonlOf(JSONL_RECORDS)}${NEWLINE}`;
    const lost = `${JSON.stringify(JSONL_RECORDS[0])}${NEWLINE}`;
    const source = recordMultiset(full);
    const result = recordMultiset(lost);
    const deficit = [...source.entries()].reduce(
      (sum, [k, n]) => sum + Math.max(0, n - (result.get(k) ?? 0)),
      0
    );
    expect(deficit).toBe(1);
  });

  test("ignores unparseable lines rather than counting them as records", () => {
    const withJunk = `${JSON.stringify(JSONL_RECORDS[0])}${NEWLINE}{ not json${NEWLINE}`;
    expect([...recordMultiset(withJunk).values()].reduce((a, b) => a + b, 0)).toBe(1);
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
