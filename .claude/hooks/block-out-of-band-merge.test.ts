import { describe, expect, it } from "bun:test";
import {
  scanForTriggerPhrases,
  extractPrNumberFromGhApiCommand,
  buildDenialReason,
  isOverrideSet,
  emitOverrideAuditLog,
  type PhraseMatch,
} from "./block-out-of-band-merge";

// ---------------------------------------------------------------------------
// scanForTriggerPhrases
// ---------------------------------------------------------------------------

describe("scanForTriggerPhrases — clean PR bodies", () => {
  it("returns empty array for an empty body", () => {
    expect(scanForTriggerPhrases("")).toEqual([]);
  });

  it("returns empty array for a body with no trigger phrases", () => {
    const body = `## Summary

Standard PR with no coupled steps. Adds a unit test and refactors a helper.

## Testing

bun test passes.`;
    expect(scanForTriggerPhrases(body)).toEqual([]);
  });

  it("does not false-positive on similar but distinct words", () => {
    // "outofband" without the hyphen is not a trigger; neither is "rooted"
    const body = "This PR adds rooted tree support and outofband processing notes.";
    expect(scanForTriggerPhrases(body)).toEqual([]);
  });
});

describe("scanForTriggerPhrases — coupled-step PR bodies", () => {
  it("matches 'out-of-band' (case-insensitive)", () => {
    const body = "This requires an OUT-OF-BAND deploy step before merging.";
    const matches = scanForTriggerPhrases(body);
    expect(matches.length).toBe(1);
    expect(matches[0].phrase).toBe("out-of-band");
    expect(matches[0].excerpt.toLowerCase()).toContain("out-of-band");
  });

  it("matches multiple distinct phrases in one body", () => {
    const body = `Railway config change required post-merge config flip.
serviceInstanceUpdate needs rootDirectory + dockerfilePath flipped.`;
    const matches = scanForTriggerPhrases(body);
    const phraseSet = new Set(matches.map((m) => m.phrase));
    expect(phraseSet.has("Railway config change")).toBe(true);
    expect(phraseSet.has("post-merge config")).toBe(true);
    expect(phraseSet.has("serviceInstanceUpdate")).toBe(true);
    expect(phraseSet.has("rootDirectory")).toBe(true);
    expect(phraseSet.has("dockerfilePath")).toBe(true);
  });

  it("matches the mt#1681 PR #1013 body shape (regression anchor)", () => {
    // Excerpts taken verbatim from PR #1013 body to ensure the originating
    // incident's PR shape would be caught by this hook. The four phrases
    // asserted below were all present in the actual PR body.
    const body = `## Design / Approach

5. **Railway service-config change** (post-merge, out-of-band): flip the reviewer
   service's rootDirectory from \`services/reviewer\` to \`""\` (repo root) and
   set dockerfilePath to \`services/reviewer/Dockerfile\` via the Railway GraphQL API.

## Live verification (post-merge)

After merge, before flipping the Railway config, the existing reviewer deploy
is still healthy. Then:

1. Flip Railway serviceInstanceUpdate for minsky-reviewer-webhook.`;
    const matches = scanForTriggerPhrases(body);
    expect(matches.length).toBeGreaterThan(0);
    const phrases = new Set(matches.map((m) => m.phrase));
    expect(phrases.has("out-of-band")).toBe(true);
    expect(phrases.has("rootDirectory")).toBe(true);
    expect(phrases.has("dockerfilePath")).toBe(true);
    expect(phrases.has("serviceInstanceUpdate")).toBe(true);
  });

  it("includes a short surrounding excerpt for each match", () => {
    const body =
      "Some preamble before the trigger — this PR requires an out-of-band Railway flip after merge.";
    const matches = scanForTriggerPhrases(body);
    expect(matches.length).toBe(1);
    expect(matches[0].excerpt.length).toBeLessThanOrEqual(160);
    expect(matches[0].excerpt).toContain("out-of-band");
  });

  it("collapses whitespace in excerpts", () => {
    const body = `requires
an out-of-band
deploy`;
    const matches = scanForTriggerPhrases(body);
    expect(matches[0].excerpt).not.toContain("\n");
  });
});

// ---------------------------------------------------------------------------
// extractPrNumberFromGhApiCommand
// ---------------------------------------------------------------------------

describe("extractPrNumberFromGhApiCommand", () => {
  it("extracts PR number from a literal gh api PUT merge command", () => {
    const cmd = "gh api -X PUT /repos/edobry/minsky/pulls/1013/merge -f merge_method=merge";
    expect(extractPrNumberFromGhApiCommand(cmd)).toBe(1013);
  });

  it("extracts PR number when path uses no leading slash (relative)", () => {
    const cmd = "gh api -X PUT repos/edobry/minsky/pulls/42/merge";
    expect(extractPrNumberFromGhApiCommand(cmd)).toBe(42);
  });

  it("returns null when the command has no PR-merge endpoint", () => {
    expect(extractPrNumberFromGhApiCommand("gh pr list")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractPrNumberFromGhApiCommand("")).toBeNull();
  });

  it("does not match /merges, /merge-upstream, or other sub-resources", () => {
    expect(extractPrNumberFromGhApiCommand("gh api /repos/o/r/pulls/1/merges")).toBeNull();
    expect(extractPrNumberFromGhApiCommand("gh api -X POST /repos/o/r/merges")).toBeNull();
    expect(extractPrNumberFromGhApiCommand("gh api -X POST /repos/o/r/merge-upstream")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isOverrideSet
// ---------------------------------------------------------------------------

describe("isOverrideSet", () => {
  it("returns true when MINSKY_ACK_OOB_MERGE=1", () => {
    expect(isOverrideSet({ MINSKY_ACK_OOB_MERGE: "1" })).toBe(true);
  });

  it("returns false when env var is unset", () => {
    expect(isOverrideSet({})).toBe(false);
  });

  it("returns false when env var is a non-1 string", () => {
    expect(isOverrideSet({ MINSKY_ACK_OOB_MERGE: "true" })).toBe(false);
    expect(isOverrideSet({ MINSKY_ACK_OOB_MERGE: "yes" })).toBe(false);
    expect(isOverrideSet({ MINSKY_ACK_OOB_MERGE: "0" })).toBe(false);
    expect(isOverrideSet({ MINSKY_ACK_OOB_MERGE: "" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// emitOverrideAuditLog (smoke — verifies it doesn't throw)
// ---------------------------------------------------------------------------

describe("emitOverrideAuditLog", () => {
  it("emits an audit-log line for a known PR with matched phrases", () => {
    const matches: PhraseMatch[] = [
      { phrase: "out-of-band", excerpt: "...this requires an out-of-band step..." },
      { phrase: "rootDirectory", excerpt: "...flip the rootDirectory to..." },
    ];
    // Should not throw; validates the function constructs without error
    expect(() => emitOverrideAuditLog(1013, matches)).not.toThrow();
  });

  it("handles null PR number gracefully", () => {
    const matches: PhraseMatch[] = [{ phrase: "out-of-band", excerpt: "x" }];
    expect(() => emitOverrideAuditLog(null, matches)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildDenialReason
// ---------------------------------------------------------------------------

describe("buildDenialReason", () => {
  it("includes the PR number in the message", () => {
    const matches: PhraseMatch[] = [{ phrase: "out-of-band", excerpt: "x" }];
    const reason = buildDenialReason(1013, matches);
    expect(reason).toContain("PR #1013");
  });

  it("includes each matched phrase in the message", () => {
    const matches: PhraseMatch[] = [
      { phrase: "out-of-band", excerpt: "ex1" },
      { phrase: "rootDirectory", excerpt: "ex2" },
    ];
    const reason = buildDenialReason(1013, matches);
    expect(reason).toContain('"out-of-band"');
    expect(reason).toContain('"rootDirectory"');
    expect(reason).toContain("ex1");
    expect(reason).toContain("ex2");
  });

  it("names the override env var", () => {
    const matches: PhraseMatch[] = [{ phrase: "out-of-band", excerpt: "x" }];
    const reason = buildDenialReason(1013, matches);
    expect(reason).toContain("MINSKY_ACK_OOB_MERGE");
  });

  it("references the originating incident and tracking task", () => {
    const matches: PhraseMatch[] = [{ phrase: "out-of-band", excerpt: "x" }];
    const reason = buildDenialReason(1013, matches);
    expect(reason).toContain("mt#1681");
    expect(reason).toContain("mt#1695");
  });

  it("falls back to 'this PR' when PR number is unknown", () => {
    const matches: PhraseMatch[] = [{ phrase: "out-of-band", excerpt: "x" }];
    const reason = buildDenialReason(null, matches);
    // Lead-in uses "this PR" instead of a "PR #N" reference
    expect(reason).toMatch(/^this PR's body/);
    // Note: the trailing reference section still mentions "PR #1013" (the
    // originating incident), which is intentional — that's a documentation
    // reference, not a claim about the PR being merged.
  });
});
