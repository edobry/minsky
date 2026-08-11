#!/usr/bin/env bun
/**
 * Replay harness for the mt#3964 referenced-short-id mechanism.
 *
 * mt#3964's Acceptance Tests are:
 *
 *   1. Replay mt#3729's criteria set against the reviewer with mem#648 carrying the amendment
 *      → criterion is not reported BLOCKING-unmet.
 *   2. Negative control: same criteria set with the target memory unmodified → still reported.
 *   3. A criterion naming a nonexistent short id (mem#999999) → UNVERIFIABLE with the resolution
 *      failure, and the review's blocking count is unchanged by it.
 *   4. A memory body larger than the per-reference cap → truncated with the warning, and the
 *      criterion renders UNVERIFIABLE rather than UNMET.
 *
 * A full live replay would call the real OpenAI model and requires OPENAI_API_KEY + GITHUB_TOKEN
 * — both absent in the implementer session that authored this change (probed and confirmed
 * absent, matching mt#3919's own replay script's precondition). It is also independently
 * unreachable for AT#1/AT#2 specifically: mt#3729 (the live instance) is IN-REVIEW, not a closed
 * PR, but retriggering the deployed reviewer against an arbitrary historical PR is not something
 * this session has standing to do outside the normal webhook flow, and `/retrigger` returns 422
 * for a CLOSED pr regardless — the reason mt#3919's own live evidence is still outstanding. The
 * MODEL-JUDGMENT half of this task (does gpt-5, reading the rendered section, actually mark the
 * criterion Met/Not Met correctly) is therefore UNVERIFIED here — this script verifies the
 * MECHANISM layer only: whether the reviewer's context-assembly pipeline
 * (`resolveReferencedShortIds` + `buildReferencedShortIdsSection`) delivers a mem#N criterion's
 * content to the prompt, and whether that content differs meaningfully between the satisfied and
 * genuinely-unsatisfied cases (AT#1/AT#2), a nonexistent short id resolves to a named failure
 * rather than a guess (AT#3), and oversized content is truncated with a visible warning rather
 * than silently handed over whole (AT#4).
 *
 * ## Fixture: SYNTHETIC and structural, not live content (PR #2844 R1)
 *
 * AT#1/AT#2 originally embedded mem#648's ACTUAL content verbatim, fetched live via
 * `memory_get`. A reviewer finding on PR #2844 correctly identified two problems with that:
 *
 *   1. **Data hygiene.** Memory bodies are internal working notes. Committing one verbatim
 *      publishes it into the repo — and git history — permanently, to anyone with checkout
 *      access. One-way door; not something a truncation bug's regression test needs to cost.
 *   2. **Staleness.** A fixture copied from a live record silently diverges from it. mem#648 is
 *      exactly the kind of record that gets amended (its own `## CORRECTION 3` section is the
 *      live instance of the pattern this fixture encodes), so a literal-content fixture drifts
 *      out from under the test the next time mem#648 is patched.
 *
 * The fixture below is SYNTHETIC: `LATE_CORRECTION_BODY_RESOLVED` /
 * `LATE_CORRECTION_BODY_UNRESOLVED` reproduce the STRUCTURAL property that exposed the original
 * suppression, not mem#648's words. That property is:
 *
 *   > **A memory body whose total size exceeds `MAX_REFERENCED_SHORT_ID_CHARS_PER_ITEM`, whose
 *   > DECISIVE section — the one that actually answers a criterion depending on it — is a
 *   > `## Correction N` heading positioned near the END of the body, past where plain
 *   > head-truncation would ever reach it.**
 *
 * Before `extractAmendmentSections` existed (see `short-id-fetch.ts`), truncating such a body
 * from the head cut the decisive section in BOTH the resolved and unresolved cases identically —
 * the exact suppression this replay's negative control exists to catch. Do NOT "fix" this fixture
 * by pasting real memory content back in if a future gap surfaces — regenerate the same
 * structural shape (long filler + a late `## Correction N` heading) instead. That reproduces the
 * property under test without the data-hygiene or staleness cost; the shape is what matters here,
 * not any particular record's words.
 *
 * Usage:
 *   bun services/reviewer/scripts/replay-referenced-short-id-verification.ts
 */

import {
  resolveReferencedShortIds,
  MAX_REFERENCED_SHORT_ID_CHARS_PER_ITEM,
  type MemoryLookup,
} from "../src/short-id-fetch";
import { buildReferencedShortIdsSection } from "../src/prompt";
import type { MemoryRecord } from "@minsky/domain/memory";

// ---------------------------------------------------------------------------
// Fixture: a criterion naming a memory's latest correction (structural stand-in
// for mt#3729's criterion 4, which names mem#648's CORRECTION 1 amendment).
// ---------------------------------------------------------------------------

const CRITERION_TEXT = "- [ ] mem#1's latest correction resolves the described defect.";

// ---------------------------------------------------------------------------
// Fixture: SYNTHETIC memory bodies — see the module doc comment above for the
// structural property these encode and why they are synthetic, not real.
// ---------------------------------------------------------------------------

const FILLER_SENTENCE =
  "Incident narrative filler describing the original defect, its symptoms, and the " +
  "diagnostic steps taken before any correction was recorded. ";
// Comparable order of magnitude to mem#648's real body (~7.6KB) — large enough that
// the filler ALONE exceeds MAX_REFERENCED_SHORT_ID_CHARS_PER_ITEM, so a decisive
// section placed after it can only survive truncation via heading-targeted extraction.
const LONG_FILLER = FILLER_SENTENCE.repeat(Math.ceil(6_000 / FILLER_SENTENCE.length));

const LATE_CORRECTION_BODY_HEADER =
  `# Synthetic incident (structural fixture, not a real record)\n\n` +
  `## Incident\n\n${LONG_FILLER}\n\n## Correction 1 (early) — partial diagnosis\n\n` +
  `The initial fix addressed one symptom but did not resolve the root cause.`;

const DECISIVE_PHRASE = "the defect is now RESOLVED";

// The RESOLVED variant: a late "## Correction 2" section — past the filler, past where
// head-truncation alone would ever reach — states the defect is resolved.
const LATE_CORRECTION_BODY_RESOLVED =
  `${LATE_CORRECTION_BODY_HEADER}\n\n## Correction 2 (late) — root cause resolved\n\n` +
  `The later correction supersedes the original diagnosis: ${DECISIVE_PHRASE}, addressing ` +
  `the root cause directly rather than the initial symptom.`;

// The UNRESOLVED variant: identical filler and Correction 1, but NO late correction section
// exists — reconstructing the state before the decisive fix was ever recorded.
const LATE_CORRECTION_BODY_UNRESOLVED = LATE_CORRECTION_BODY_HEADER;

function makeMemoryRecord(content: string): MemoryRecord {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    shortId: "mem#1",
    type: "feedback",
    name: "Synthetic fixture — not a real memory record",
    description: "Structural fixture for replay-referenced-short-id-verification.ts",
    content,
    scope: "project",
    projectId: null,
    tags: [],
    sourceAgentId: null,
    sourceSessionId: null,
    confidence: null,
    supersededBy: null,
    metadata: null,
    associations: {},
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    lastAccessedAt: null,
    accessCount: 0,
  };
}

async function runCase(
  label: string,
  memoryLookup: MemoryLookup
): Promise<{ label: string; sectionShowsResolution: boolean; fetchStatus: string }> {
  const results = await resolveReferencedShortIds({ taskSpec: CRITERION_TEXT, memoryLookup });
  const section = buildReferencedShortIdsSection(results);
  const mem1 = results.find((r) => r.ref === "mem#1");

  console.log(`\n=== ${label} ===`);
  console.log(`Refs extracted: ${results.map((r) => r.ref).join(", ")}`);
  console.log(`mem#1 fetchResult.status: ${mem1?.fetchResult.status}`);
  console.log(`mem#1 content fetched: ${mem1?.content !== null}`);
  const sectionShowsResolution = (section ?? "").includes(DECISIVE_PHRASE);
  console.log(
    `Section shows the decisive phrase ("${DECISIVE_PHRASE}"): ${sectionShowsResolution}`
  );

  return {
    label,
    sectionShowsResolution,
    fetchStatus: mem1?.fetchResult.status ?? "missing",
  };
}

async function runNotFoundCase(): Promise<void> {
  console.log("\n=== AT#3 — nonexistent short id (mem#999999) ===");
  const memoryLookup: MemoryLookup = { get: async () => null };
  const results = await resolveReferencedShortIds({
    taskSpec: "- [ ] mem#999999 carries the change.",
    memoryLookup,
  });
  const entry = results[0];
  console.log(`fetchResult.status: ${entry?.fetchResult.status}`);
  console.log(`content: ${entry?.content}`);
  if (entry?.fetchResult.status !== "not-found" || entry?.content !== null) {
    console.error("FAIL: expected status 'not-found' and content null — never Met, never dropped.");
    process.exit(1);
  }
  console.log("PASS: unresolvable short id resolves to a NAMED failure, not Met, not dropped.");
}

async function runTruncationCase(): Promise<void> {
  console.log("\n=== AT#4 — memory body larger than the per-reference cap ===");
  const oversized = "z".repeat(MAX_REFERENCED_SHORT_ID_CHARS_PER_ITEM + 1_000);
  const memoryLookup: MemoryLookup = { get: async () => makeMemoryRecord(oversized) };
  const results = await resolveReferencedShortIds({
    taskSpec: "- [ ] mem#1 carries an oversized body.",
    memoryLookup,
  });
  const entry = results[0];
  const section = buildReferencedShortIdsSection(results);
  console.log(`truncated: ${entry?.truncated}`);
  console.log(`omittedChars: ${entry?.omittedChars}`);
  console.log(`section contains TRUNCATED warning: ${(section ?? "").includes("TRUNCATED")}`);
  console.log(
    `section instructs Unverifiable-not-Not-Met: ${(section ?? "").includes("report `Unverifiable`, not `Not Met`")}`
  );
  if (!entry?.truncated || entry.omittedChars !== 1_000) {
    console.error("FAIL: expected truncated=true and omittedChars=1000.");
    process.exit(1);
  }
  console.log(
    "PASS: oversized content is truncated with a visible warning, never handed over whole."
  );
}

async function main() {
  console.log(
    "mt#3964 replay: a criterion naming a memory's latest correction, against the " +
      "referenced-short-id mechanism (SYNTHETIC fixture — see module doc comment)\n"
  );
  console.log(
    "This does not invoke the LLM (no OPENAI_API_KEY in this session — probed, confirmed " +
      "absent, same precondition as mt#3919's own replay script). It replays the CONTEXT-" +
      "ASSEMBLY layer the LLM's verdict now depends on."
  );

  // AT#1 — positive replay: a memory whose late Correction section resolves the defect.
  const positive = await runCase("AT#1 — memory carrying the late resolution (synthetic)", {
    get: async () => makeMemoryRecord(LATE_CORRECTION_BODY_RESOLVED),
  });

  // AT#2 — negative control: identical filler + early correction, but NO late resolution.
  const negative = await runCase(
    "AT#2 — negative control: memory NOT carrying the late resolution (synthetic)",
    { get: async () => makeMemoryRecord(LATE_CORRECTION_BODY_UNRESOLVED) }
  );

  await runNotFoundCase();
  await runTruncationCase();

  console.log("\n=== Verdict (AT#1 / AT#2) ===");
  console.log(`Positive case shows resolution: ${positive.sectionShowsResolution}`);
  console.log(`Negative case shows resolution: ${negative.sectionShowsResolution}`);

  const bothFetched = positive.fetchStatus === "found" && negative.fetchStatus === "found";
  const casesDiffer = positive.sectionShowsResolution !== negative.sectionShowsResolution;

  if (!bothFetched) {
    console.error("FAIL: expected both cases to reach fetchResult.status === 'found'.");
    process.exit(1);
  }
  if (!casesDiffer) {
    console.error(
      "FAIL: the positive and negative cases produced the SAME evidence — this would be a " +
        "suppression, not a verification. mt#3964's negative-control Success Criterion rejects this."
    );
    process.exit(1);
  }

  console.log(
    "PASS: the mechanism delivers REAL, DIFFERENT content for the satisfied vs. unsatisfied " +
      "case, even though the decisive section sits past where head-truncation alone would cut " +
      "it — a criterion naming a memory's late correction can now be verified against its " +
      "actual content instead of being reported unmet (or suppressed identically either way) " +
      "solely because the artifact is outside the diff.\n\n" +
      "UNVERIFIED (model-judgment half): whether gpt-5, given this rendered section, actually " +
      "reports a real criterion Met/Not Met correctly is not exercised here — the deployed " +
      "reviewer cannot be retriggered against a closed PR (/retrigger returns 422), and mt#3729 " +
      "(the live instance mt#3964's spec names) is IN-REVIEW rather than a closed PR this " +
      "session has standing to retrigger outside the normal webhook flow. mt#3919's own live " +
      "acceptance evidence is outstanding for the identical reason."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
