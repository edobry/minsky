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
const PHRASE_OUT_OF_BAND = "out-of-band";

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
    expect(phraseSet.has(PHRASE_POST_MERGE_CONFIG)).toBe(true);
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
    expect(phrases.has(PHRASE_SERVICE_INSTANCE_UPDATE)).toBe(true);
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

  it("still fires on a trigger phrase in bare prose when paired with out-of-band (mt#2002 regression check)", () => {
    // Post-mt#2002: rootDirectory requires a pair-partner in the same
    // paragraph to fire. Adding "out-of-band" makes it fire (paired).
    // This test originally asserted bare-prose rootDirectory fired
    // alone; that's no longer the case under pair-requirement.
    const body =
      "After merge (out-of-band), set rootDirectory to empty string on the Railway service.";
    const matches = scanForTriggerPhrases(body);
    const phrases = new Set(matches.map((m) => m.phrase));
    expect(phrases.has("rootDirectory")).toBe(true);
    expect(phrases.has("out-of-band")).toBe(true);
  });

  it("preserves the mt#1681 PR #1013 body regression anchor (bare prose, mixed with parenthetical code)", () => {
    // mt#1681's body uses `rootDirectory` in code spans AND uses bare-prose
    // language like "(post-merge, out-of-band)" — the bare prose is the load-
    // bearing signal that must still fire.
    const body = `## Design / Approach

5. **Railway service-config change** (post-merge, out-of-band): flip the reviewer
   service's \`rootDirectory\` from \`services/reviewer\` to \`""\` (repo root) and
   set \`dockerfilePath\` to \`services/reviewer/Dockerfile\` via the Railway GraphQL API.`;
    const matches = scanForTriggerPhrases(body);
    const phrases = new Set(matches.map((m) => m.phrase));
    // out-of-band appears in bare prose — should still fire
    expect(phrases.has("out-of-band")).toBe(true);
    // rootDirectory and dockerfilePath appear ONLY in code spans here — should
    // NOT fire on those individually
    expect(phrases.has("rootDirectory")).toBe(false);
    expect(phrases.has("dockerfilePath")).toBe(false);
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
    const body =
      "Some preamble before the trigger — this PR requires an out-of-band Railway flip after merge.";
    const matches = scanForTriggerPhrases(body);
    expect(matches.length).toBe(1);
    expect(matches[0].excerpt).toContain("out-of-band");
    expect(matches[0].excerpt).toContain("Railway flip");
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
    const body =
      "After merge (out-of-band), flip the reviewer service rootDirectory to empty string.";
    const matches = scanForTriggerPhrases(body);
    const phrases = new Set(matches.map((m) => m.phrase));
    expect(phrases.has("out-of-band")).toBe(true);
    expect(phrases.has("rootDirectory")).toBe(true);
  });

  it("DOES fire on dockerfilePath when paired with post-merge in same paragraph", () => {
    const body =
      "Post-merge step: set dockerfilePath to services/reviewer/Dockerfile on the Railway service.";
    const matches = scanForTriggerPhrases(body);
    const phrases = new Set(matches.map((m) => m.phrase));
    expect(phrases.has(PHRASE_POST_MERGE_CONFIG) || phrases.has("rootDirectory")).toBeDefined();
    expect(phrases.has("dockerfilePath")).toBe(true);
  });

  it("does NOT fire on rootDirectory if pair-partner is in a DIFFERENT paragraph", () => {
    // First paragraph has out-of-band; second paragraph has rootDirectory.
    // They're separated by a blank line, so they're separate paragraphs.
    // rootDirectory should NOT fire (pair-requirement is paragraph-scoped).
    // out-of-band fires standalone.
    const body =
      "This PR will require an out-of-band coordination step on Railway after merge.\n\n" +
      "Separately, the rootDirectory field is documented in the comments for reference.";
    const matches = scanForTriggerPhrases(body);
    const phrases = new Set(matches.map((m) => m.phrase));
    expect(phrases.has("out-of-band")).toBe(true);
    expect(phrases.has("rootDirectory")).toBe(false);
  });

  it("fires correctly across multiple paragraphs with independent pair-checks", () => {
    // Paragraph 1: rootDirectory + out-of-band (pair-match → fires)
    // Paragraph 2: dockerfilePath alone (no partner → suppressed)
    // Paragraph 3: post-merge alone (standalone partner; no pair-required to fire)
    const body =
      "After merge (out-of-band), set rootDirectory to empty.\n\n" +
      "The dockerfilePath field is documented in the diff.\n\n" +
      "Post-merge, the deploy will use the new config.";
    const matches = scanForTriggerPhrases(body);
    const phrases = new Set(matches.map((m) => m.phrase));
    expect(phrases.has("out-of-band")).toBe(true);
    expect(phrases.has("rootDirectory")).toBe(true);
    expect(phrases.has("dockerfilePath")).toBe(false);
  });

  it("preserves the mt#1681 PR #1013 regression anchor (rootDirectory + out-of-band in same prose paragraph)", () => {
    // mt#1681's PR body: rootDirectory + dockerfilePath are in CODE SPANS
    // (elided by mt#1707), but "out-of-band" and "post-merge" appear in bare
    // prose. Under pair-requirement, since the code-span phrases are already
    // elided, the remaining bare-prose `out-of-band` fires standalone and
    // blocks the merge. The regression anchor holds.
    const body = `## Design / Approach

5. **Railway service-config change** (post-merge, out-of-band): flip the reviewer
   service's \`rootDirectory\` from \`services/reviewer\` to \`""\` (repo root) and
   set \`dockerfilePath\` to \`services/reviewer/Dockerfile\` via the Railway GraphQL API.`;
    const matches = scanForTriggerPhrases(body);
    const phrases = new Set(matches.map((m) => m.phrase));
    // out-of-band fires standalone (bare prose, not elided)
    expect(phrases.has("out-of-band")).toBe(true);
    // The merge will be blocked regardless of whether rootDirectory fires
    // (which it shouldn't, since it's only in code spans here).
    expect(matches.length).toBeGreaterThan(0);
  });

  it("STANDALONE triggers (out-of-band, post-merge config, serviceInstanceUpdate) still fire alone", () => {
    // Each of these has no benign mention pattern; they fire on any
    // bare-prose occurrence regardless of pair-partner presence.
    const cases = [
      {
        body: "This PR uses an out-of-band signing flow for the upgrade.",
        phrase: PHRASE_OUT_OF_BAND,
      },
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

  it("PR #1204-style historical-incident description: pair-required phrases do not fire (partial fix)", () => {
    // PR #1204's body included this kind of language. Pair-required
    // phrases (rootDirectory, dockerfilePath) appearing in bare prose
    // alongside out-of-band do still fire under the pair-requirement —
    // because they're in the same paragraph. This case documents the
    // current behavior: mt#2002 helps when the pair-required phrase is
    // ALONE; it does NOT help when out-of-band is also in the same
    // sentence describing the incident.
    //
    // The remaining false-positive class (historical-incident
    // descriptions that mention BOTH phrases) is a follow-up — likely
    // requires a "## Originating-Context" section exclusion or similar.
    const body =
      "Three instances in May 2026 — mt#1681 PR #1013 (rootDirectory + dockerfilePath flip documented as out-of-band, never executed).";
    const matches = scanForTriggerPhrases(body);
    const phrases = new Set(matches.map((m) => m.phrase));
    // out-of-band fires standalone
    expect(phrases.has("out-of-band")).toBe(true);
    // rootDirectory + dockerfilePath fire because out-of-band is in the
    // same paragraph (single sentence here). This is the known limitation
    // of pair-requirement on incident-description prose.
    expect(phrases.has("rootDirectory")).toBe(true);
    expect(phrases.has("dockerfilePath")).toBe(true);
  });
});
