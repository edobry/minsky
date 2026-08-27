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
  isNarrowSearch,
  isScopeNarrowSearch,
  claimsQualifiedTo,
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

/**
 * The mt#4362 scope leg: a search narrow in TERRITORY but rich in HITS.
 *
 * The R11 fixture is real — implementing mt#4359 an agent wrote "truncateToCodePoints
 * currently has NO call sites" into a durable docblock on the strength of
 * `grep -rn "truncateToCodePoints" .minsky/hooks/`, which returned EIGHT hits.
 * Repo-wide the symbol has 16. The conclusion happened to be true; the warrant
 * was not, which is why no outcome-based check could ever have surfaced it.
 */
describe("scope leg (mt#4362)", () => {
  const subtree = (hitCount: number, scopePath = ".minsky/hooks/"): SearchObservation => ({
    toolName: "Bash",
    hitCount,
    scope: "subtree",
    scopePath,
  });
  const repoWide = (hitCount: number): SearchObservation => ({
    toolName: "Bash",
    hitCount,
    scope: "repo",
  });

  const UNQUALIFIED = "Checked mt#2677's helper: it has no call sites anywhere in the repo.";
  const QUALIFIED = "Checked mt#2677's helper: it has no call sites under .minsky/hooks/.";

  it("AT1 — a subtree search rich in hits fires on an unqualified claim", () => {
    const result = detectNegativeExistenceClaim({
      artifactProse: UNQUALIFIED,
      searches: [subtree(8)],
      doneTaskIds: new Set(["mt#2677"]),
    });
    // Assert the claim leg matched FIRST, so a pass cannot be mistaken for the
    // conjunction succeeding by some other route (mem#704).
    expect(result.claims.length).toBeGreaterThan(0);
    expect(result.matched).toBe(true);
    expect(result.thinSearches).toHaveLength(1);
    expect(result.thinSearches[0]?.scope).toBe("subtree");
  });

  it("AT2 — the SAME search at repo scope does not fire, so the leg is what admitted it", () => {
    const result = detectNegativeExistenceClaim({
      artifactProse: UNQUALIFIED,
      searches: [repoWide(8)],
      doneTaskIds: new Set(["mt#2677"]),
    });
    // Identical hit count, identical prose, identical task — ONLY scope differs.
    expect(result.claims.length).toBeGreaterThan(0);
    expect(result.matched).toBe(false);
  });

  it("AT3 — a claim carrying the searched subtree as a qualifier does not fire", () => {
    const result = detectNegativeExistenceClaim({
      artifactProse: QUALIFIED,
      searches: [subtree(8)],
      doneTaskIds: new Set(["mt#2677"]),
    });
    expect(result.claims.length).toBeGreaterThan(0);
    expect(result.matched).toBe(false);
  });

  it("a qualifier naming a DIFFERENT subtree than the one searched still fires", () => {
    const result = detectNegativeExistenceClaim({
      artifactProse: "Checked mt#2677's helper: it has no call sites under src/cockpit/.",
      searches: [subtree(8)],
      doneTaskIds: new Set(["mt#2677"]),
    });
    expect(result.matched).toBe(true);
  });

  it("AT4 — a count-thin search still fires unchanged, with no scope classified", () => {
    const result = detectNegativeExistenceClaim({
      artifactProse: UNQUALIFIED,
      searches: [thin(TASKS_SEARCH)],
      doneTaskIds: new Set(["mt#2677"]),
    });
    expect(result.matched).toBe(true);
    expect(result.thinSearches[0]?.scope).toBeUndefined();
  });

  it("AT4 — a count-thin search is NOT excused by a matching qualifier", () => {
    // The SC5 test gates only the scope leg. A repo-wide search returning one
    // hit is thin regardless of how the sentence is worded.
    const result = detectNegativeExistenceClaim({
      artifactProse: QUALIFIED,
      searches: [{ toolName: "Bash", hitCount: 1, scope: "subtree", scopePath: ".minsky/hooks/" }],
      doneTaskIds: new Set(["mt#2677"]),
    });
    expect(result.matched).toBe(true);
  });

  it("an unscopable search never satisfies the scope leg", () => {
    const result = detectNegativeExistenceClaim({
      artifactProse: UNQUALIFIED,
      searches: [{ toolName: TASKS_SEARCH, hitCount: 25, scope: "unscopable" }],
      doneTaskIds: new Set(["mt#2677"]),
    });
    expect(result.matched).toBe(false);
  });

  it("an unclassified scope is not narrow — an adapter that did not label fails quiet", () => {
    expect(isScopeNarrowSearch(wide("Grep"))).toBe(false);
    expect(isNarrowSearch(wide("Grep"))).toBe(false);
    expect(isNarrowSearch(subtree(8))).toBe(true);
    expect(isNarrowSearch(thin())).toBe(true);
  });

  it("claimsQualifiedTo normalizes ./ and trailing slashes", () => {
    const claims = extractNegativeExistenceClaims(QUALIFIED);
    expect(claimsQualifiedTo(claims, "./.minsky/hooks")).toBe(true);
    expect(claimsQualifiedTo(claims, ".minsky/hooks/")).toBe(true);
    expect(claimsQualifiedTo(claims, "src/")).toBe(false);
    expect(claimsQualifiedTo(claims, undefined)).toBe(false);
    expect(claimsQualifiedTo([], ".minsky/hooks/")).toBe(false);
  });
});
