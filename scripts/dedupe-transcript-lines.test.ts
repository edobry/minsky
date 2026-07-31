/** Tests for the pure dedupe kernel of scripts/dedupe-transcript-lines.ts (mt#2862). */
import { describe, test, expect } from "bun:test";
import { dedupeByLineUuid, type TranscriptLine } from "./dedupe-transcript-lines";

const L = (uuid: string | undefined, tag: string): TranscriptLine =>
  uuid === undefined ? { tag } : { uuid, tag };

describe("dedupeByLineUuid", () => {
  test("interleaved duplicates are removed keeping first occurrence, order preserved", () => {
    // Mirrors the observed mt#2789 corruption shape: pairwise interleaved chunks.
    const lines = [
      L("u1", "a"),
      L("u2", "b"),
      L("u1", "a-dup"),
      L("u3", "c"),
      L("u2", "b-dup"),
      L("u3", "c-dup"),
    ];
    const { deduped, removed } = dedupeByLineUuid(lines);
    expect(removed).toBe(3);
    expect(deduped.map((l) => l.tag)).toEqual(["a", "b", "c"]);
  });

  test("elements without a string uuid are never removed, even when repeated", () => {
    const noUuid1 = L(undefined, "x");
    const noUuid2 = L(undefined, "x"); // identical shape, still kept
    const numericUuid = { uuid: 42, tag: "n" } as TranscriptLine;
    const { deduped, removed } = dedupeByLineUuid([noUuid1, noUuid2, numericUuid]);
    expect(removed).toBe(0);
    expect(deduped).toHaveLength(3);
  });

  test("array with no duplicates is unchanged", () => {
    const lines = [L("u1", "a"), L("u2", "b")];
    const { deduped, removed } = dedupeByLineUuid(lines);
    expect(removed).toBe(0);
    expect(deduped.map((l) => l.tag)).toEqual(["a", "b"]);
  });

  test("empty array round-trips", () => {
    const { deduped, removed } = dedupeByLineUuid([]);
    expect(removed).toBe(0);
    expect(deduped).toEqual([]);
  });

  test("null-ish elements do not crash and are kept", () => {
    const lines = [null as unknown as TranscriptLine, L("u1", "a"), L("u1", "a-dup")];
    const { deduped, removed } = dedupeByLineUuid(lines);
    expect(removed).toBe(1);
    expect(deduped).toHaveLength(2);
  });
});
