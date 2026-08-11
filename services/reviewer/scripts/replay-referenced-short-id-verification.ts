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
 * this session has standing to do outside the normal webhook flow, and the coordinating agent's
 * own dispatch note records `/retrigger` returning 422 for a CLOSED pr as the reason mt#3919's own
 * live evidence is still outstanding. The MODEL-JUDGMENT half of this task (does gpt-5, reading
 * the rendered section, actually mark the criterion Met/Not Met correctly) is therefore
 * UNVERIFIED here — this script verifies the MECHANISM layer only: whether the reviewer's
 * context-assembly pipeline (`resolveReferencedShortIds` + `buildReferencedShortIdsSection`) now
 * delivers a mem#N criterion's REAL, CURRENT memory content to the prompt, and whether that
 * content differs meaningfully between the satisfied and genuinely-unsatisfied cases (AT#1/AT#2),
 * a nonexistent short id resolves to a named failure rather than a guess (AT#3), and oversized
 * content is truncated with a visible warning rather than silently handed over whole (AT#4).
 *
 * ## Fixture provenance
 *
 * - `CRITERION_4_TEXT`: mt#3729's actual criterion 4, `tasks_spec_get({ taskId: "mt#3729",
 *   section: "Success Criteria" })`, read 2026-08-11 (task status at read time: IN-REVIEW).
 * - `MEM_648_CURRENT_CONTENT`: mem#648's actual `content` field, `memory_get({ id: "mem#648" })`,
 *   read 2026-08-11 (`updatedAt` at read time: `2026-08-05T02:05:43.036Z`). Ends with "##
 *   CORRECTION 3 (2026-08-04) — the ask-then-grant path is right, but it is not the FIRST move" —
 *   the amendment criterion 4 names.
 * - `MEM_648_PRE_CORRECTION_3` is DERIVED, not independently fetched: it is
 *   `MEM_648_CURRENT_CONTENT` sliced at the `CORRECTION_3_MARKER`, reconstructing the
 *   pre-2026-08-04 state — mem#648 has no earlier version fetchable via `memory_get` (memories are
 *   mutated in place via `memory_patch`, not versioned) — mirroring the AMENDMENT_MARKER slicing
 *   technique `replay-referenced-spec-verification.ts` (mt#3919) used for mt#3874.
 *
 * mem#648 is a live, actively-referenced memory and may be patched further; if the CORRECTION 3
 * section's wording changes, refresh via `memory_get({ id: "mem#648" })` and re-run.
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
import { safeTruncate } from "@minsky/shared/safe-truncate";

// ---------------------------------------------------------------------------
// Fixture: mt#3729's actual criterion 4 (verbatim)
// ---------------------------------------------------------------------------

const CRITERION_4_TEXT =
  "4. mem#648's CORRECTION 1 is amended: the ask-then-grant path stays correct, but is no longer " +
  "the\n   FIRST move for a verified false positive.";

// ---------------------------------------------------------------------------
// Fixture: mem#648's actual, current content (fetched live, 2026-08-11)
// ---------------------------------------------------------------------------

const MEM_648_CURRENT_CONTENT =
  '# Reviewer-bot duplicate-section false positive on a long rule (PR #2106 / mt#2921, 2026-07-20/21)\n\n> **STATUS 2026-08-01: this class is now structurally contained.** mt#3520 (PR #2521, merged\n> `46ee22c44`) added a `duplicate-section` claim class to\n> `services/reviewer/src/structural-claim-verifier.ts`: before a BLOCKING finding posts, every\n> heading it quotes is counted in the file\'s CURRENT content at the review ref, and the finding is\n> demoted unless one of them genuinely repeats. This incident\'s shape — one long section read as\n> two, grep-disproven — is exactly what that check falsifies. Two claims below have also been\n> corrected against later evidence; read the corrections before relying on this entry.\n\n**Incident.** PR #2106 added `.minsky/rules/claim-confidence.mdc` (a ~170-line `alwaysApply:true` vocabulary rule → ~9.7KB in compiled CLAUDE.md/AGENTS.md). The reviewer bot (`minsky-reviewer[bot]` via gpt-5) posted a BLOCKING finding: "Duplicate \'# Claim Confidence\' section appears twice in AGENTS.md." Ground truth: `grep -c "Claim Confidence" AGENTS.md` = 1 (single heading at line 1948). The bot read the ONE long section\'s start (near the operational-reference-rules list) and end (its cross-references, just before `# Error Investigation` at 2116) as TWO sections.\n\n**Persistent across 2 rounds.** After a `reviewer_retrigger`, round 2 (reviewId 4739906993) re-flagged the identical false positive but placed the phantom second occurrence at a DIFFERENT line (`:1` vs round 1\'s `:1946`) — location inconsistency confirms hallucination. Round 2 self-contradicted: its spec-verification marked all 3 criteria "Met" and described "a new # Claim Confidence section" (singular) while the finding claimed two.\n\n**Family / tracking.** Same class as mt#2575 (reviewer asserts a file-content fact without filesystem access) and mt#2044 (false "already-addressed"). Structural fix is mt#2960 (verification + confidence-gating pass over candidate findings before posting) / mt#2836 refutation. Recurrence trigger here: a LONG single section, where the bot loses section boundaries and miscounts occurrences.\n\n## CORRECTION 1 (2026-08-01) — the forceBypass / status-check inference is FALSIFIED\n\nThis entry originally recorded, explicitly flagged as INFERRED and unverified:\n\n> `session_pr_merge(forceBypass:true, ...)` on this verified-false-positive CHANGES_REQUESTED review\n> was refused ... The final refusal suggests forceBypass dismisses the REVIEW yet the failing\n> `minsky-reviewer/findings` STATUS CHECK (set by the finding) remains an independent merge blocker.\n\n**That mechanism is not what happens.** On PR #2498 (2026-08-01, mt#3409), a `forceBypass` merge\nsucceeded while `minsky-reviewer/findings` was RED — 8 of 9 checks green, the reviewer\'s own check\nthe sole failure — so the failing findings check is NOT an independent merge blocker.\n\nWhat the refusal in this incident actually reflected: the merge-review gate refuses a\nREQUEST_CHANGES bypass unless an **operator-approved D8 grant** covers it (`hook-files.mdc`\n§Merge-review REQUEST_CHANGES override; the grant path is `scripts/grant-guard-override.ts --guard\nrequire-review-before-merge --ask <askId>`, and `ASK_REQUIRED_GUARDS` makes the `--ask` mandatory\nfor that guard alone). No such grant existed here, so `forceBypass` alone could not clear it. On\nPR #2498 the grant existed (ask#6666, operator-approved) and the merge went through unimpeded.\n\n**Behavioral note, revised.** When a reviewer false positive also reddens the findings check, do\nNOT permute bypasses — but the escalation is specific and cheap: verify the finding is false, file\nan `authorization.approve` Ask, and on approval issue the grant scoped to\n`<owner/repo>#<pr>@<headSha>`. That is a supported path, not a dead end.\n\n## CORRECTION 2 (2026-08-01) — the mechanism is not unique to long sections\n\nThis entry attributed the miscount to section LENGTH ("a LONG single section, where the bot loses\nsection boundaries"). That remains a plausible mechanism for THIS incident, but it is not the only\none producing the identical claim. mt#2575 instance 6 (PR #2498) produced the same\n"section appears twice" claim where the repeated text spanned a canonical source and its compile\noutput — two files, boundaries intact. Treat "duplicate section" findings as suspect on the CLAIM\nSHAPE, not on a guess about which mechanism generated them; that is why mt#3520\'s check counts\nheadings in the file rather than trying to model the cause.\n\n## Cross-references\n## CORRECTION 3 (2026-08-04) — the ask-then-grant path is right, but it is not the FIRST move\n\nCORRECTION 1 above established that filing an `authorization.approve` Ask and issuing a scoped\ngrant is "a supported path, not a dead end." That remains true and is not withdrawn. What it is\nmissing is a cheaper rung ahead of it.\n\n**Incident (PR #2640 / mt#3713).** One BLOCKING finding: `src/generated/completion-manifest.json`\n"edited directly." Verified false — re-running the generator left `git status` on that file empty,\nand it ships the same way in several merged PRs — and no code change could satisfy it (the manifest\nis a committed generated artifact, so any PR adding a CLI param includes it). Following CORRECTION 1\nliterally, the agent filed the ask. That **paged the principal at 21:50**. A `reviewer_retrigger`\non the SAME HEAD then returned **APPROVED with zero blocking findings** ~2 minutes later; the PR\nmerged normally. The escalation was avoidable in full.\n\n**Corrected order** for a verified-false-positive finding:\n\n> read the posted review (§7b) → verify against the cited location (`8fdfc3d8`) → **if false AND\n> unfixable, `reviewer_retrigger` ONCE on the same HEAD** → file the ask + grant only if the\n> re-review re-fires it.\n\n**Why once, and why a re-fire is the escalation signal.** This entry\'s own originating incident is\nthe counter-example: there, a retrigger re-flagged the identical false positive at a different\nphantom line number. That is precisely when the operator grant is correct. A re-fire distinguishes\na durable disagreement from a flake, and it costs ~2 minutes to obtain.\n\n**Composes with, does not contradict, §7b (mt#2829).** §7b forbids a BLIND retrigger that discards\nan unread verdict\'s diagnostic prose. This rung fires only AFTER the review has been read and the\nfinding diagnosed, so nothing is discarded.\n\n**Also a reviewer-side gap.** mt#3520 (DONE) added a `duplicate-section` claim class to\n`structural-claim-verifier.ts` so false claims of that shape are demoted deterministically before\nposting. This incident\'s claim shape — "generated file edited directly," on a file whose committed\nbytes exactly equal its generator\'s output — is a DIFFERENT class the verifier does not check, so\nit posted unverified. The verifier is claim-class-keyed, so each new false-claim shape needs its own\nclass until the general finder→verifier pass (mt#2960, TODO) lands. Recorded as evidence there.\n\n**Tracking:** mt#3729 (the retrigger rung + a grant-path precondition requiring ≥2 reviews on the\ncurrent HEAD). Budget: if a verified-false-positive is escalated to an operator grant again before\nmt#3729 ships, escalate mt#2960\'s priority — the agent-side ladder is then not the binding\nconstraint.\n\n\n\nmt#3520 / PR #2521 (the containing fix) · mt#2575 (family anchor; this is an unnumbered early\ninstance, PR #2498 is instance 6) · mt#2960 (general finder→verifier pipeline, still TODO) ·\nmt#3310 (the verifier logs only demotions — "ran, nothing to demote" is still indistinguishable\nfrom "never ran") · mt#2989 (the D8 merge-review override path Correction 1 describes) · mt#2044.\n';

// ---------------------------------------------------------------------------
// Fixture: mem#648's content BEFORE the amendment (reconstructed by trimming
// at the CORRECTION 3 marker) — this is the genuinely-unsatisfied negative
// control criterion 4 depends on.
// ---------------------------------------------------------------------------

const CORRECTION_3_MARKER = "## CORRECTION 3 (2026-08-04)";
const correction3SplitIndex = MEM_648_CURRENT_CONTENT.indexOf(CORRECTION_3_MARKER);
if (correction3SplitIndex === -1) {
  throw new Error(`fixture error: "${CORRECTION_3_MARKER}" not found in MEM_648_CURRENT_CONTENT`);
}
const MEM_648_PRE_CORRECTION_3 = safeTruncate(
  MEM_648_CURRENT_CONTENT,
  correction3SplitIndex,
  "head"
).trim();

function makeMemoryRecord(content: string): MemoryRecord {
  return {
    id: "8b40f396-650e-418f-bbba-dca92fe3289f",
    shortId: "mem#648",
    type: "feedback",
    name: "Reviewer bot hallucinates a duplicate section on a long always-loaded rule",
    description: "fixture",
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
    createdAt: new Date("2026-07-21T00:05:07.270Z"),
    updatedAt: new Date("2026-08-05T02:05:43.036Z"),
    lastAccessedAt: null,
    accessCount: 36,
  };
}

const AMENDED_PHRASE = "it is not the FIRST move";

async function runCase(
  label: string,
  memoryLookup: MemoryLookup
): Promise<{ label: string; sectionContainsAmendment: boolean; fetchStatus: string }> {
  const results = await resolveReferencedShortIds({ taskSpec: CRITERION_4_TEXT, memoryLookup });
  const section = buildReferencedShortIdsSection(results);
  const mem648 = results.find((r) => r.ref === "mem#648");

  console.log(`\n=== ${label} ===`);
  console.log(`Refs extracted: ${results.map((r) => r.ref).join(", ")}`);
  console.log(`mem#648 fetchResult.status: ${mem648?.fetchResult.status}`);
  console.log(`mem#648 content fetched: ${mem648?.content !== null}`);
  const sectionContainsAmendment = (section ?? "").includes(AMENDED_PHRASE);
  console.log(
    `Section shows the amendment phrase ("${AMENDED_PHRASE}"): ${sectionContainsAmendment}`
  );

  return {
    label,
    sectionContainsAmendment,
    fetchStatus: mem648?.fetchResult.status ?? "missing",
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
    taskSpec: "- [ ] mem#648 carries an oversized body.",
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
    "mt#3964 replay: mt#3729's criterion 4 against the referenced-short-id mechanism\n" +
      "(mem#648, live content fetched 2026-08-11)\n"
  );
  console.log(
    "This does not invoke the LLM (no OPENAI_API_KEY in this session — probed, confirmed " +
      "absent, same precondition as mt#3919's own replay script). It replays the CONTEXT-" +
      "ASSEMBLY layer the LLM's verdict now depends on."
  );

  // AT#1 — positive replay: mem#648's REAL, CURRENT content (carrying the amendment).
  const positive = await runCase("AT#1 — mem#648 carrying the amendment (real, current state)", {
    get: async () => makeMemoryRecord(MEM_648_CURRENT_CONTENT),
  });

  // AT#2 — negative control: mem#648 WITHOUT the amendment (reconstructed pre-2026-08-04 state).
  const negative = await runCase(
    "AT#2 — negative control: mem#648 NOT carrying the amendment (pre-2026-08-04 state)",
    { get: async () => makeMemoryRecord(MEM_648_PRE_CORRECTION_3) }
  );

  await runNotFoundCase();
  await runTruncationCase();

  console.log("\n=== Verdict (AT#1 / AT#2) ===");
  console.log(`Positive case shows amendment: ${positive.sectionContainsAmendment}`);
  console.log(`Negative case shows amendment: ${negative.sectionContainsAmendment}`);

  const bothFetched = positive.fetchStatus === "found" && negative.fetchStatus === "found";
  const casesDiffer = positive.sectionContainsAmendment !== negative.sectionContainsAmendment;

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
      "case — mt#3729 criterion 4 can now be verified against mem#648's actual content instead of " +
      "being reported unmet solely because the artifact is outside the diff.\n\n" +
      "UNVERIFIED (model-judgment half): whether gpt-5, given this rendered section, actually " +
      "reports the criterion Met/Not Met correctly is not exercised here — the deployed reviewer " +
      "cannot be retriggered against a closed PR (/retrigger returns 422), and mt#3729 (the live " +
      "instance) is IN-REVIEW rather than a closed PR this session has standing to retrigger " +
      "outside the normal webhook flow. mt#3919's own live acceptance evidence is outstanding for " +
      "the identical reason."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
