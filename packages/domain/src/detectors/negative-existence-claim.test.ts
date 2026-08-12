/**
 * Tests for the negative-existence-claim matcher (mt#3918).
 *
 * These cover the PURE conjunct logic. The hook adapter's transcript wiring,
 * DONE-status lookup and evaluation stream are covered by
 * `.minsky/hooks/negative-existence-claim-detector.test.ts`, which carries the
 * spec's AT1-AT5.
 */

import { describe, it, expect } from "bun:test";
import {
  countSearchHits,
  detectNegativeExistenceClaim,
  extractCitedTaskIds,
  extractNegativeExistenceClaims,
  isSearchCall,
  isThinSearch,
} from "./negative-existence-claim";
import type { SearchObservation } from "./negative-existence-claim";

const TASKS_SEARCH = "mcp__minsky__tasks_search";

const thin = (toolName = "Grep"): SearchObservation => ({ toolName, hitCount: 1 });
const wide = (toolName = "Grep"): SearchObservation => ({ toolName, hitCount: 25 });

describe("extractNegativeExistenceClaims", () => {
  it("matches the mt#3916 claim shape", () => {
    const claims = extractNegativeExistenceClaims(
      "Checked the progress mechanism: there are zero production call sites, so no long-running tool has ever emitted progress."
    );
    expect(claims.length).toBeGreaterThan(0);
    expect(claims[0]?.phrase.toLowerCase()).toContain("call site");
  });

  it("carries surrounding context so a reviewer can tell assertion from quotation", () => {
    const claims = extractNegativeExistenceClaims(
      "The prior agent wrote that the helper is never called, which turned out to be false."
    );
    expect(claims[0]?.excerpt).toContain("turned out to be false");
  });

  it("returns nothing for prose making no negative existence claim", () => {
    expect(
      extractNegativeExistenceClaims("The helper is called from three sites and all of them pass.")
    ).toEqual([]);
  });

  it("deduplicates a phrase matched by more than one pattern", () => {
    const claims = extractNegativeExistenceClaims("It has no callers. It has no callers.");
    const phrases = claims.map((c) => c.phrase);
    expect(new Set(phrases).size).toBe(phrases.length);
  });
});

describe("extractCitedTaskIds", () => {
  it("collects distinct task refs", () => {
    expect(extractCitedTaskIds("per mt#2677 and mt#3918, and mt#2677 again").sort()).toEqual([
      "mt#2677",
      "mt#3918",
    ]);
  });

  it("returns empty when nothing is cited", () => {
    expect(extractCitedTaskIds("no refs here")).toEqual([]);
  });
});

describe("isThinSearch", () => {
  it("treats zero and one hits as thin", () => {
    expect(isThinSearch({ toolName: "Grep", hitCount: 0 })).toBe(true);
    expect(isThinSearch({ toolName: "Grep", hitCount: 1 })).toBe(true);
  });

  it("does not treat a many-hit search as thin", () => {
    expect(isThinSearch({ toolName: "Grep", hitCount: 2 })).toBe(false);
  });

  it("does NOT treat an uncountable result as thin", () => {
    // Opposite direction from the DONE-lookup's fail-toward-firing, deliberately:
    // an uncountable result is evidence about the parser, not about the corpus.
    expect(isThinSearch({ toolName: "Grep", hitCount: null })).toBe(false);
  });
});

describe("countSearchHits", () => {
  it("counts one hit per non-empty line", () => {
    expect(countSearchHits("src/a.ts:1: match\nsrc/b.ts:9: match\n")).toBe(2);
  });

  it("reads an empty body as zero", () => {
    expect(countSearchHits("   \n  ")).toBe(0);
  });

  it("recognizes explicit no-match markers", () => {
    expect(countSearchHits("No matches found")).toBe(0);
    expect(countSearchHits("Found 0 matches")).toBe(0);
  });

  it("prefers an explicit count over the line count", () => {
    expect(countSearchHits("Found 42 matches\nsrc/a.ts\nsrc/b.ts")).toBe(42);
  });

  it("accepts a trailing summary line too", () => {
    expect(countSearchHits("src/a.ts\nsrc/b.ts\nFound 42 matches")).toBe(42);
  });

  it("ignores a count buried mid-body and counts the lines instead", () => {
    // PR #2905 R1: an explicit count is a SUMMARY convention, so it is
    // authoritative only at an edge. A mid-body mention is prose.
    const body = "src/a.ts:1: x\nthe earlier pass found 42 matches here\nsrc/b.ts:9: x";
    expect(countSearchHits(body)).toBe(3);
  });
});

describe("isSearchCall", () => {
  it("recognizes the named search tools", () => {
    expect(isSearchCall("Grep", undefined)).toBe(true);
    expect(isSearchCall(TASKS_SEARCH, undefined)).toBe(true);
  });

  it("recognizes a shell search by its leading token", () => {
    expect(isSearchCall("Bash", "grep -rn 'foo' src")).toBe(true);
    expect(isSearchCall("Bash", "/usr/bin/rg foo")).toBe(true);
  });

  it("classifies a pipeline by its FIRST stage, not a downstream filter", () => {
    expect(isSearchCall("Bash", "cat foo.txt | grep bar")).toBe(false);
  });

  it("is not a search for an unrelated tool", () => {
    expect(isSearchCall("Read", undefined)).toBe(false);
    expect(isSearchCall("Bash", "bun test")).toBe(false);
  });
});

describe("detectNegativeExistenceClaim", () => {
  const prose = "Verified: mt#2677's mechanism has no callers in production.";

  it("fires when all three conjuncts hold", () => {
    const result = detectNegativeExistenceClaim({
      artifactProse: prose,
      searches: [thin()],
      doneTaskIds: new Set(["mt#2677"]),
    });
    expect(result.matched).toBe(true);
    expect(result.doneTaskIds).toEqual(["mt#2677"]);
    expect(result.doneLookupUnavailable).toBe(false);
  });

  it("does not fire when the supporting search was wide", () => {
    const result = detectNegativeExistenceClaim({
      artifactProse: prose,
      searches: [wide()],
      doneTaskIds: new Set(["mt#2677"]),
    });
    expect(result.matched).toBe(false);
  });

  it("does not fire when the cited task is not DONE", () => {
    const result = detectNegativeExistenceClaim({
      artifactProse: prose,
      searches: [thin()],
      doneTaskIds: new Set(),
    });
    expect(result.matched).toBe(false);
  });

  it("does not fire when no task is cited at all", () => {
    const result = detectNegativeExistenceClaim({
      artifactProse: "The mechanism has no callers in production.",
      searches: [thin()],
      doneTaskIds: null,
    });
    expect(result.matched).toBe(false);
  });

  it("does not fire when the prose makes no negative existence claim", () => {
    const result = detectNegativeExistenceClaim({
      artifactProse: "mt#2677 shipped the progress mechanism and three tools use it.",
      searches: [thin()],
      doneTaskIds: new Set(["mt#2677"]),
    });
    expect(result.matched).toBe(false);
  });

  it("FIRES when the DONE lookup could not run, and flags why", () => {
    const result = detectNegativeExistenceClaim({
      artifactProse: prose,
      searches: [thin()],
      doneTaskIds: null,
    });
    expect(result.matched).toBe(true);
    expect(result.doneLookupUnavailable).toBe(true);
    expect(result.doneTaskIds).toEqual(["mt#2677"]);
  });

  it("keeps the thin search that bound the claim for the record", () => {
    const result = detectNegativeExistenceClaim({
      artifactProse: prose,
      searches: [wide("Glob"), thin(TASKS_SEARCH)],
      doneTaskIds: new Set(["mt#2677"]),
    });
    expect(result.thinSearches).toHaveLength(1);
    expect(result.thinSearches[0]?.toolName).toBe(TASKS_SEARCH);
  });
});
