import { describe, expect, it } from "bun:test";
import {
  scanForTriggerPhrases,
  elideMarkdownNonProse,
  extractPrNumberFromGhApiCommand,
  buildDenialReason,
  isOverrideSet,
  emitOverrideAuditLog,
  type PhraseMatch,
} from "./block-out-of-band-merge";

// Trigger-phrase literals — kept as named constants so test assertions can
// reference them without duplicating string literals across many cases (the
// magic-string-duplication lint rule fires at 3+ literal occurrences).
const PHRASE_SERVICE_INSTANCE_UPDATE = "serviceInstanceUpdate";
const PHRASE_POST_MERGE_CONFIG = "post-merge config";
const PHRASE_ROOT_DIRECTORY = "rootDirectory";
// Note: "out-of-band" is a PAIR_PARTNER (activates pair-required phrases when
// co-occurring with them in the same paragraph) but is NOT itself a trigger
// phrase since mt#2019 removed it from STANDALONE_TRIGGER_PHRASES to prevent
// false positives on architectural prose like "out-of-band consumers".
// Use PHRASE_ROOT_DIRECTORY or PHRASE_SERVICE_INSTANCE_UPDATE for true-positive
// test assertions that require Railway-coordination context.

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
  it("does NOT match 'out-of-band' alone — mt#2019 false-positive fix (architectural prose)", () => {
    // mt#2019: "out-of-band" was removed from STANDALONE_TRIGGER_PHRASES to
    // prevent false positives on architectural prose like "out-of-band consumers"
    // (mt#2010 originating incident). Bare occurrences of out-of-band in prose
    // that don't co-occur with Railway/config field names should not fire.
    const body = "This requires an OUT-OF-BAND deploy step before merging.";
    const matches = scanForTriggerPhrases(body);
    expect(matches.length).toBe(0);
  });

  it("matches multiple distinct phrases in one body", () => {
    const body = `Railway config change required post-merge config flip.
serviceInstanceUpdate needs rootDirectory + dockerfilePath flipped.`;
    const matches = scanForTriggerPhrases(body);
    const phraseSet = new Set(matches.map((m) => m.phrase));
    expect(phraseSet.has("Railway config change")).toBe(true);
    expect(phraseSet.has(PHRASE_POST_MERGE_CONFIG)).toBe(true);
    expect(phraseSet.has(PHRASE_SERVICE_INSTANCE_UPDATE)).toBe(true);
    expect(phraseSet.has("rootDirectory")).toBe(true);
    expect(phraseSet.has("dockerfilePath")).toBe(true);
  });

  it("matches the mt#1681 PR #1013 body shape (regression anchor)", () => {
    // Excerpts taken verbatim from PR #1013 body to ensure the originating
    // incident's PR shape would be caught by this hook.
    //
    // After mt#2019: "out-of-band" is no longer a standalone trigger.
    // The hook still fires because:
    //   1. serviceInstanceUpdate appears in bare prose (standalone trigger)
    //   2. rootDirectory appears in bare prose alongside out-of-band in
    //      the same paragraph (pair-requirement satisfied)
    //
    // In this test body, rootDirectory and dockerfilePath appear WITHOUT
    // backtick code spans (unlike the mt#1707 regression test). The backticks
    // here surround the VALUE strings (`services/reviewer`, `""`), not the
    // field names themselves. So rootDirectory fires via pair-requirement.
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
    // serviceInstanceUpdate appears in bare prose — fires standalone
    expect(phrases.has(PHRASE_SERVICE_INSTANCE_UPDATE)).toBe(true);
    // rootDirectory appears in bare prose with out-of-band in same paragraph
    // — pair-requirement fires it
    expect(phrases.has("rootDirectory")).toBe(true);
    // out-of-band is no longer a standalone trigger (mt#2019)
    expect(phrases.has("out-of-band")).toBe(false);
  });

  it("includes a short surrounding excerpt for each match", () => {
    // Uses serviceInstanceUpdate (standalone trigger) to test excerpt extraction.
    // "out-of-band" was removed from standalone triggers in mt#2019.
    const body = `Some preamble before the trigger — this PR calls ${PHRASE_SERVICE_INSTANCE_UPDATE} on the Railway service.`;
    const matches = scanForTriggerPhrases(body);
    expect(matches.length).toBe(1);
    expect(matches[0].excerpt.length).toBeLessThanOrEqual(160);
    expect(matches[0].excerpt).toContain(PHRASE_SERVICE_INSTANCE_UPDATE);
  });

  it("collapses whitespace in excerpts", () => {
    // Uses serviceInstanceUpdate (standalone trigger) to test excerpt whitespace collapsing.
    // "out-of-band" was removed from standalone triggers in mt#2019.
    const body = `requires
serviceInstanceUpdate
deploy`;
    const matches = scanForTriggerPhrases(body);
    expect(matches[0].excerpt).not.toContain("\n");
  });
});

describe("scanForTriggerPhrases — markdown filtering (mt#1707)", () => {
  it("does not fire on a trigger phrase inside an inline code span", () => {
    const body = "This PR adds a `rootDirectory` field reference to DEPLOY.md.";
    expect(scanForTriggerPhrases(body)).toEqual([]);
  });

  it("does not fire on a trigger phrase inside a fenced code block", () => {
    const body = `## Acceptance evidence

\`\`\`bash
$ grep "dockerfilePath" services/reviewer/DEPLOY.md
\`\`\`

Docs-only change.`;
    expect(scanForTriggerPhrases(body)).toEqual([]);
  });

  it("does not fire on a trigger phrase inside a blockquote line", () => {
    const body = `Reviewer noted:

> serviceInstanceUpdate is the GraphQL mutation name.

Acknowledged in the doc.`;
    expect(scanForTriggerPhrases(body)).toEqual([]);
  });

  it("still fires on pair-required phrase in bare prose when paired with out-of-band (mt#2002/mt#2019 regression check)", () => {
    // mt#2002: rootDirectory requires a pair-partner in the same paragraph to fire.
    // mt#2019: "out-of-band" is no longer a standalone trigger, but it IS still a
    // PAIR_PARTNER — so rootDirectory still fires when co-occurring with out-of-band.
    // After mt#2019: only rootDirectory fires (out-of-band is not itself a trigger).
    const body =
      "After merge (out-of-band), set rootDirectory to empty string on the Railway service.";
    const matches = scanForTriggerPhrases(body);
    const phrases = new Set(matches.map((m) => m.phrase));
    expect(phrases.has("rootDirectory")).toBe(true);
    // out-of-band is a PAIR_PARTNER, not a trigger phrase — does not appear in results
    expect(phrases.has("out-of-band")).toBe(false);
  });

  it("mt#1681 PR #1013 body: code-span field names not fired, out-of-band no longer standalone (mt#2019)", () => {
    // mt#1681's body uses `rootDirectory` in code spans AND uses bare-prose
    // language like "(post-merge, out-of-band)".
    //
    // After mt#2019: "out-of-band" is no longer a standalone trigger. And
    // rootDirectory/dockerfilePath are ONLY in code spans (elided by mt#1707),
    // so no pair-matching fires either. This body alone (without the bare-prose
    // serviceInstanceUpdate line) would NOT fire the hook.
    //
    // This is intentional — this PR body excerpt by itself describes what IS
    // happening (field values in code spans). The full mt#1681 PR body also
    // contains "Flip Railway serviceInstanceUpdate for minsky-reviewer-webhook"
    // in bare prose (the regression anchor test covers the full body).
    const body = `## Design / Approach

5. **Railway service-config change** (post-merge, out-of-band): flip the reviewer
   service's \`rootDirectory\` from \`services/reviewer\` to \`""\` (repo root) and
   set \`dockerfilePath\` to \`services/reviewer/Dockerfile\` via the Railway GraphQL API.`;
    const matches = scanForTriggerPhrases(body);
    const phrases = new Set(matches.map((m) => m.phrase));
    // out-of-band is no longer standalone (mt#2019) — does not fire alone
    expect(phrases.has("out-of-band")).toBe(false);
    // rootDirectory and dockerfilePath appear ONLY in code spans — not fired
    expect(phrases.has("rootDirectory")).toBe(false);
    expect(phrases.has("dockerfilePath")).toBe(false);
    // This excerpt has no standalone triggers either
    expect(matches.length).toBe(0);
  });

  it("fires on prose occurrence when the same phrase also appears in a code span (paired)", () => {
    // First occurrence is in a code span (must be ignored); second is in prose.
    // Excerpt must come from the prose location, not the code span.
    // Post-mt#2002: rootDirectory requires a pair-partner; "out-of-band" is
    // added to the prose context so the pair-requirement is satisfied.
    const body =
      "This PR documents the `rootDirectory` field. " +
      "The deploy step is: set rootDirectory to empty as an out-of-band action.";
    const matches = scanForTriggerPhrases(body);
    const phrases = new Set(matches.map((m) => m.phrase));
    expect(phrases.has("rootDirectory")).toBe(true);
    // Excerpt must show the prose context (contains "deploy step") rather than
    // the code-span context (contains "documents the").
    const rootDirMatch = matches.find((m) => m.phrase === "rootDirectory");
    if (!rootDirMatch) throw new Error("expected rootDirectory match");
    expect(rootDirMatch.excerpt).toContain("deploy step");
    expect(rootDirMatch.excerpt).not.toContain("documents the");
  });

  it("allows a PR #1021-style docs body (code-span field references throughout)", () => {
    // Synthetic body modeled on the mt#1701 PR #1021 case: doc PR that
    // references the Railway field names as code-span identifiers, with no
    // coordination-instruction prose.
    const body = `## Summary

Updates DEPLOY.md to reflect the post-mt#1681 build context.

## Key Changes

1. Documents the new \`rootDirectory\` value (empty string).
2. Documents the explicit \`dockerfilePath\` field locating the Dockerfile.
3. JSON config-merge example for \`serviceInstanceUpdate\` is updated.

## Testing

Pre-commit hook passes.`;
    expect(scanForTriggerPhrases(body)).toEqual([]);
  });

  it("filters trigger phrases inside multi-line fenced code blocks", () => {
    const body = `Smoke output:

\`\`\`
$ grep "rootDirectory\\|dockerfilePath" services/reviewer/DEPLOY.md
services/reviewer/DEPLOY.md:rootDirectory  ""
services/reviewer/DEPLOY.md:dockerfilePath services/reviewer/Dockerfile
\`\`\``;
    expect(scanForTriggerPhrases(body)).toEqual([]);
  });

  it("excerpts continue to slice from the original body (positions preserved)", () => {
    // Phrase appears in prose; verify the excerpt contains the original
    // surrounding text — confirms position preservation in the elision pass.
    // Uses serviceInstanceUpdate (standalone trigger) since "out-of-band" is
    // no longer a standalone trigger (mt#2019).
    const body = `Some preamble before the trigger — this PR calls ${PHRASE_SERVICE_INSTANCE_UPDATE} on the Railway service after merge.`;
    const matches = scanForTriggerPhrases(body);
    expect(matches.length).toBe(1);
    expect(matches[0].excerpt).toContain(PHRASE_SERVICE_INSTANCE_UPDATE);
    expect(matches[0].excerpt).toContain("Railway service");
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

describe("elideMarkdownNonProse", () => {
  it("returns input unchanged when no code spans / fences / blockquotes are present", () => {
    const body = "Plain prose with no markdown contexts.";
    expect(elideMarkdownNonProse(body)).toBe(body);
  });

  it("blanks an inline code span but preserves the surrounding text", () => {
    const body = "Use the `foo` value here.";
    const out = elideMarkdownNonProse(body);
    expect(out).toBe("Use the       value here.");
    expect(out.length).toBe(body.length);
  });

  it("blanks a fenced code block but preserves newlines for line-anchored passes", () => {
    const body = "before\n```\nsecret\n```\nafter";
    const out = elideMarkdownNonProse(body);
    // Newlines preserved; non-newline characters blanked inside the fence.
    expect(out.length).toBe(body.length);
    expect(out.startsWith("before\n")).toBe(true);
    expect(out.endsWith("\nafter")).toBe(true);
    // The fence content lines are all whitespace
    const fenceLines = out.split("\n").slice(1, 4);
    for (const line of fenceLines) {
      expect(line).toMatch(/^\s*$/);
    }
  });

  it("blanks a blockquote line but preserves prose lines around it", () => {
    const body = "before\n> quoted note here\nafter";
    const out = elideMarkdownNonProse(body);
    expect(out.length).toBe(body.length);
    expect(out.startsWith("before\n")).toBe(true);
    expect(out.endsWith("\nafter")).toBe(true);
    // The blockquote line is all whitespace (no `>` or content remains)
    const blockquoteLine = out.split("\n")[1] as string;
    expect(blockquoteLine).toMatch(/^ +$/);
    expect(blockquoteLine.length).toBe("> quoted note here".length);
  });

  it("preserves overall length so indexOf results are valid in both texts", () => {
    const body = "prose then `code-span` then more prose ending with a blockquote\n> note here.";
    const out = elideMarkdownNonProse(body);
    expect(out.length).toBe(body.length);
  });
});

describe("elideMarkdownNonProse — CommonMark variants (PR #1028 R1)", () => {
  it("elides inline code spans with multi-backtick delimiters (R1 BLOCKING #1)", () => {
    // CommonMark: any matching N-backtick run delimits an inline code span.
    const body = "This PR documents the ``rootDirectory`` field and adds examples.";
    expect(scanForTriggerPhrases(body)).toEqual([]);
  });

  it("elides inline code spans containing internal backticks", () => {
    // Double-backtick span with a single backtick inside the content
    const body = "Use ``rootDirectory`note`` as a reference.";
    expect(scanForTriggerPhrases(body)).toEqual([]);
  });

  it("elides indented fenced code blocks (R1 BLOCKING #2)", () => {
    // CommonMark allows up to 3 spaces of indentation before the fence.
    const body = "Smoke output:\n\n   ```bash\n$ grep 'rootDirectory' file\n   ```\n";
    expect(scanForTriggerPhrases(body)).toEqual([]);
  });

  it("elides tilde-fenced code blocks (R1 BLOCKING #2)", () => {
    const body = "Output:\n\n~~~\nserviceInstanceUpdate is a Railway mutation.\n~~~\n";
    expect(scanForTriggerPhrases(body)).toEqual([]);
  });

  it("elides backtick fences with info strings and trailing whitespace", () => {
    const body = "```typescript  \nconst x = 'dockerfilePath';\n```\n";
    expect(scanForTriggerPhrases(body)).toEqual([]);
  });

  it("elides fences with CRLF line endings", () => {
    const body = "before\r\n```\r\nrootDirectory is documented here\r\n```\r\nafter\r\n";
    expect(scanForTriggerPhrases(body)).toEqual([]);
  });

  it("elides nested blockquotes (>>)", () => {
    const body = "Reviewer said:\n\n>> serviceInstanceUpdate is the GraphQL name\n\nAck.";
    expect(scanForTriggerPhrases(body)).toEqual([]);
  });

  it("elides blockquotes with up to 3 leading spaces", () => {
    const body = "Quote:\n\n   > rootDirectory is documented\n\nEnd.";
    expect(scanForTriggerPhrases(body)).toEqual([]);
  });

  it("elides blockquote lines with CRLF endings", () => {
    const body = "intro\r\n> serviceInstanceUpdate is the name\r\noutro";
    expect(scanForTriggerPhrases(body)).toEqual([]);
  });

  it("preserves length on all CommonMark variants (position invariant)", () => {
    const bodies = [
      "``foo``",
      "   ```bash\nx\n   ```",
      "~~~\nx\n~~~",
      "```typescript  \nx\n```",
      "before\r\n```\r\nx\r\n```\r\nafter",
      ">> nested",
      "   > indented",
      "> crlf\r\nprose",
    ];
    for (const body of bodies) {
      expect(elideMarkdownNonProse(body).length).toBe(body.length);
    }
  });

  it("known limitation: lazy continuation lines are NOT elided (documented; paired)", () => {
    // CommonMark allows a blockquote paragraph to wrap onto subsequent lines
    // without the `>` marker. Our regex-based pass elides only marked lines,
    // so wrapped prose may remain scannable. The reviewer flagged this as
    // NON-BLOCKING; documented here so a future false-positive can be
    // diagnosed quickly. The first marked line is still elided.
    //
    // Post-mt#2002: rootDirectory requires a pair-partner; "out-of-band" is
    // added to the lazy-continuation line so the pair-requirement is
    // satisfied and the test still demonstrates the elision limitation.
    const body =
      "> Perform serviceInstanceUpdate on Railway\nrootDirectory must be set too, out-of-band.";
    const matches = scanForTriggerPhrases(body);
    const phrases = new Set(matches.map((m) => m.phrase));
    // The marked-line phrase is elided
    expect(phrases.has(PHRASE_SERVICE_INSTANCE_UPDATE)).toBe(false);
    // The lazy-continuation line is NOT elided (known limitation) AND
    // contains out-of-band as a pair-partner, so rootDirectory fires.
    expect(phrases.has("rootDirectory")).toBe(true);
  });
});

describe("scanForTriggerPhrases — pair-requirement (mt#2002)", () => {
  it("does NOT fire on bare-prose rootDirectory when no pair-partner in same paragraph", () => {
    // PR body documents a Railway field name without any coordination
    // language — this is the false-positive class mt#2002 fixes.
    const body =
      "This PR documents the rootDirectory field used by the synthesizer. " +
      "All changes are in-PR with no manual coordination steps.";
    const matches = scanForTriggerPhrases(body);
    const phrases = new Set(matches.map((m) => m.phrase));
    expect(phrases.has("rootDirectory")).toBe(false);
  });

  it("does NOT fire on bare-prose dockerfilePath when no pair-partner in same paragraph", () => {
    const body =
      "The dockerfilePath setting is now declarative via deploy.config.ts. " +
      "Apply via the synthesizer; no manual Railway dashboard edit required.";
    const matches = scanForTriggerPhrases(body);
    const phrases = new Set(matches.map((m) => m.phrase));
    expect(phrases.has("dockerfilePath")).toBe(false);
  });

  it("DOES fire on rootDirectory when paired with out-of-band in same paragraph", () => {
    // out-of-band is a PAIR_PARTNER that activates rootDirectory. After mt#2019,
    // out-of-band is no longer itself a trigger — it doesn't appear in results.
    // But rootDirectory fires because out-of-band is present in the same paragraph.
    const body =
      "After merge (out-of-band), flip the reviewer service rootDirectory to empty string.";
    const matches = scanForTriggerPhrases(body);
    const phrases = new Set(matches.map((m) => m.phrase));
    // out-of-band is a PAIR_PARTNER, not a trigger — not in the results
    expect(phrases.has("out-of-band")).toBe(false);
    // rootDirectory fires because out-of-band is in the same paragraph
    expect(phrases.has("rootDirectory")).toBe(true);
  });

  it("DOES fire on dockerfilePath when paired with post-merge in same paragraph", () => {
    const body =
      "Post-merge step: set dockerfilePath to services/reviewer/Dockerfile on the Railway service.";
    const matches = scanForTriggerPhrases(body);
    const phrases = new Set(matches.map((m) => m.phrase));
    expect(phrases.has("dockerfilePath")).toBe(true);
  });

  it("does NOT fire on rootDirectory if pair-partner is in a DIFFERENT paragraph", () => {
    // First paragraph has out-of-band; second paragraph has rootDirectory.
    // They're separated by a blank line, so they're separate paragraphs.
    // rootDirectory should NOT fire (pair-requirement is paragraph-scoped).
    // After mt#2019: out-of-band is also no longer standalone, so neither fires.
    const body =
      "This PR will require an out-of-band coordination step on Railway after merge.\n\n" +
      "Separately, the rootDirectory field is documented in the comments for reference.";
    const matches = scanForTriggerPhrases(body);
    const phrases = new Set(matches.map((m) => m.phrase));
    // out-of-band is no longer standalone (mt#2019) — doesn't fire even when alone
    expect(phrases.has("out-of-band")).toBe(false);
    // rootDirectory has no partner in its paragraph — doesn't fire
    expect(phrases.has("rootDirectory")).toBe(false);
    // Nothing fires — the hook allows this merge
    expect(matches.length).toBe(0);
  });

  it("fires correctly across multiple paragraphs with independent pair-checks", () => {
    // Paragraph 1: rootDirectory + out-of-band (pair-match → rootDirectory fires)
    // Paragraph 2: dockerfilePath alone (no partner → suppressed)
    // Paragraph 3: post-merge alone (PAIR_PARTNER without a pair-required phrase → nothing fires)
    //
    // After mt#2019: out-of-band is a PAIR_PARTNER, not a trigger. It activates
    // rootDirectory but doesn't itself appear in the matches set.
    const body =
      "After merge (out-of-band), set rootDirectory to empty.\n\n" +
      "The dockerfilePath field is documented in the diff.\n\n" +
      "Post-merge, the deploy will use the new config.";
    const matches = scanForTriggerPhrases(body);
    const phrases = new Set(matches.map((m) => m.phrase));
    // out-of-band is a PAIR_PARTNER (not a trigger) — not in results
    expect(phrases.has("out-of-band")).toBe(false);
    // rootDirectory fires because out-of-band is in the same paragraph
    expect(phrases.has("rootDirectory")).toBe(true);
    // dockerfilePath alone (no partner in its paragraph) — doesn't fire
    expect(phrases.has("dockerfilePath")).toBe(false);
  });

  it("preserves the mt#1681 PR #1013 regression anchor (full body with bare-prose serviceInstanceUpdate)", () => {
    // mt#1681's full PR body: rootDirectory + dockerfilePath are in CODE SPANS
    // (elided by mt#1707). After mt#2019, "out-of-band" is no longer a standalone
    // trigger. The regression anchor is now preserved via "serviceInstanceUpdate"
    // in bare prose — it appears as a standalone trigger on the "Flip Railway
    // serviceInstanceUpdate" line.
    const body = `## Design / Approach

5. **Railway service-config change** (post-merge, out-of-band): flip the reviewer
   service's \`rootDirectory\` from \`services/reviewer\` to \`""\` (repo root) and
   set \`dockerfilePath\` to \`services/reviewer/Dockerfile\` via the Railway GraphQL API.

## Live verification (post-merge)

After merge, before flipping the Railway config, the existing reviewer deploy
is still healthy. Then:

1. Flip Railway serviceInstanceUpdate for minsky-reviewer-webhook.`;
    const matches = scanForTriggerPhrases(body);
    const phrases = new Set(matches.map((m) => m.phrase));
    // serviceInstanceUpdate fires standalone (bare prose, not elided)
    expect(phrases.has(PHRASE_SERVICE_INSTANCE_UPDATE)).toBe(true);
    // The merge is blocked by the serviceInstanceUpdate standalone trigger
    expect(matches.length).toBeGreaterThan(0);
    // out-of-band is no longer standalone (mt#2019) — doesn't appear in results
    expect(phrases.has("out-of-band")).toBe(false);
  });

  it("STANDALONE triggers (post-merge config, serviceInstanceUpdate) still fire alone (mt#2019: out-of-band removed)", () => {
    // After mt#2019: "out-of-band" is no longer a standalone trigger (moved to
    // PAIR_PARTNER only). The remaining standalones fire on any bare-prose
    // occurrence regardless of pair-partner presence.
    const cases = [
      { body: "Includes a post-merge config update step.", phrase: PHRASE_POST_MERGE_CONFIG },
      {
        body: "Calls serviceInstanceUpdate to apply the change.",
        phrase: PHRASE_SERVICE_INSTANCE_UPDATE,
      },
    ];
    for (const { body, phrase } of cases) {
      const matches = scanForTriggerPhrases(body);
      const phrases = new Set(matches.map((m) => m.phrase));
      expect(phrases.has(phrase)).toBe(true);
    }
  });

  it("PR #1204-style historical-incident description: pair-required phrases still fire when co-occurring with out-of-band (known limitation)", () => {
    // PR #1204's body included this kind of language. Pair-required
    // phrases (rootDirectory, dockerfilePath) appearing in bare prose
    // alongside out-of-band do still fire under the pair-requirement —
    // because they're in the same paragraph. This case documents the
    // current behavior: mt#2002 helps when the pair-required phrase is
    // ALONE; it does NOT help when out-of-band is also in the same
    // sentence describing the incident.
    //
    // After mt#2019: out-of-band is no longer a standalone trigger so it
    // doesn't appear in results itself — but it's still a PAIR_PARTNER that
    // activates rootDirectory/dockerfilePath in the same paragraph.
    //
    // The remaining false-positive class (historical-incident descriptions
    // that mention BOTH phrases) is a follow-up — likely requires a
    // "## Originating-Context" section exclusion or similar.
    const body =
      "Three instances in May 2026 — mt#1681 PR #1013 (rootDirectory + dockerfilePath flip documented as out-of-band, never executed).";
    const matches = scanForTriggerPhrases(body);
    const phrases = new Set(matches.map((m) => m.phrase));
    // out-of-band is no longer standalone (mt#2019) — doesn't appear in results
    expect(phrases.has("out-of-band")).toBe(false);
    // rootDirectory + dockerfilePath fire because out-of-band (PAIR_PARTNER)
    // is in the same paragraph. This is the known limitation: incident-
    // description prose that uses both phrases still triggers the hook.
    expect(phrases.has("rootDirectory")).toBe(true);
    expect(phrases.has("dockerfilePath")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mt#2019 acceptance tests — false-positive reduction
// ---------------------------------------------------------------------------

describe("scanForTriggerPhrases — mt#2019 acceptance tests", () => {
  it("mt#2010 false-positive: 'out-of-band consumers' in architectural prose does NOT fire", () => {
    // Originating incident: mt#2010 PR #1217. The PR body described
    // `discovery-config.ts` as importable by "out-of-band consumers (smoke
    // scripts, unit tests)" — architectural prose about module callers in
    // the import graph. The hook incorrectly blocked the merge.
    //
    // After mt#2019: "out-of-band" is no longer a standalone trigger.
    // This PR body should not fire the hook.
    const body = `## Summary

Adds the \`discoverDeploymentConfig\` function to \`discovery-config.ts\` to make
it importable by out-of-band consumers (smoke scripts, unit tests) without
pulling in the full server bootstrap.

## Testing

bun test passes.`;
    expect(scanForTriggerPhrases(body)).toEqual([]);
  });

  it("mt#2010 false-positive: variant phrasings of architectural 'out-of-band' consumers do NOT fire", () => {
    // Additional phrasings of the same architectural pattern that should not fire.
    const bodies = [
      "The module can be used out-of-band by scripts that need config discovery.",
      "Out-of-band callers (unit tests, CLI tools) import this module directly.",
      "This function is safe to call out-of-band outside the server context.",
    ];
    for (const body of bodies) {
      expect(scanForTriggerPhrases(body)).toEqual([]);
    }
  });

  it("mt#1681 true-positive: full PR #1013 body still fires (regression anchor preserved)", () => {
    // The originating true-positive incident. After mt#2019, the hook still
    // fires on this body because `serviceInstanceUpdate` appears in bare prose.
    // The merge would be correctly blocked.
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
    // serviceInstanceUpdate in bare prose is the load-bearing true-positive signal
    expect(phrases.has(PHRASE_SERVICE_INSTANCE_UPDATE)).toBe(true);
  });

  it("post-merge config coordination step still fires (standalone trigger preserved)", () => {
    // "post-merge config" is still a standalone trigger — coordination steps
    // documented this way should be caught.
    const body = `## Summary

Refactors the Railway config pipeline.

## Post-merge steps

This PR requires a post-merge config update to the Railway service dashboard
to set the new environment variable.`;
    const matches = scanForTriggerPhrases(body);
    const phrases = new Set(matches.map((m) => m.phrase));
    expect(phrases.has(PHRASE_POST_MERGE_CONFIG)).toBe(true);
  });

  it("out-of-band + rootDirectory in same paragraph still fires via pair-requirement", () => {
    // Even though out-of-band is no longer standalone, the combination of
    // out-of-band + rootDirectory in the same paragraph is still a strong
    // coordination signal and fires via pair-requirement.
    const body =
      "After merge, perform the out-of-band step: set rootDirectory to empty string on the Railway service.";
    const matches = scanForTriggerPhrases(body);
    const phrases = new Set(matches.map((m) => m.phrase));
    expect(phrases.has(PHRASE_ROOT_DIRECTORY)).toBe(true);
  });
});
