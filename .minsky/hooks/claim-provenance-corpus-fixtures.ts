// mt#4190 — REAL fires from the transcript corpus, sampled verbatim.
//
// WHY THESE ARE NOT HAND-WRITTEN. mem#1020: a detector fixture that matches
// NOTHING is loud under a positive assertion and SILENT under a negative one —
// `expect(detect(x)).toEqual([])` passes forever on an inert input, and it
// survives its own negative control, because "nothing matched" is stable
// whether or not the code under test is disabled. Two of the three instances
// recorded there were paraphrases of text that existed verbatim within reach.
// This tune's whole content is negative assertions ("this must STOP firing"),
// which is exactly the blind direction, so every fixture below is copied out of
// `scripts/replay-claim-provenance.ts --detail` output rather than written from
// memory.
//
// Each carries its transcript, line and task so a later reader can re-derive it:
//
//   bun scripts/replay-claim-provenance.ts <dir>/<transcript>.jsonl --detail
//
// PROVENANCE IS THE POINT — do not "tidy" these. Rewrapping a line, dropping a
// backtick or shortening a path is a paraphrase, and re-probing after any such
// edit is required (mem#1002).

/**
 * DEFENSIBLE FIRE — a real file-level collision assertion, no read in the prefix.
 *
 * Transcript `97e86322-cad2-4dce-9be9-fba5d39e636c.jsonl:1003`, `tasks_spec_patch`
 * on mt#4234, cites PR #3088.
 *
 * This is a RECALL CONTROL, and it is the reason the elision pass below is
 * composed rather than adopted wholesale. Its filenames live inside backticks —
 * as this corpus's filenames essentially always do — so applying
 * `elideMarkdownNonProse`'s inline-code-span pass before matching would delete
 * the file-token half of the conjunction and take the fire rate toward zero. That
 * reads as a triumphant precision win and is the guard switched off.
 */
export const DEFENSIBLE_COLLISION_MT4234 = `Filed rather than walked immediately, and the reason is parallel work rather than preference: this
was surfaced by mt#3801's SC7 re-measurement while **PR #3088 was open on the same files**. Its
in-scope set (\`registry-prompt-scan-guards.ts\`, and \`ask-routing-deferral-detector.ts\` if the
decision is to trim) overlaps that branch, so planning it before the merge would collide with an
in-flight PR.
`;

/**
 * DEFENSIBLE FIRE — a file-level co-location claim about a sibling task.
 *
 * Transcript `9e43fad5-ccd7-4a4f-a356-d8cc212ed012.jsonl:1187`, `tasks_create`,
 * cites PR #3055. Second recall control; same backticked-path shape.
 */
export const DEFENSIBLE_COLLISION_MT4188 = `- Origin: \`minsky-reviewer[bot]\` NON-BLOCKING finding on PR #3055 (mt#4188), 2026-08-17.
- mt#4188 is the sibling fix in the same file: its selector keyed on \`scrubGateOk\`, a field
  ADR-040 removed, so the script SKIPped every no-argument run and verified nothing from mt#3268
  until then.
- The \`SemanticEvent\` schema is \`packages/domain/src/transcripts/event-schema.ts\`; the script's
  local \`SemanticEventShape\` is a structural subset used for assertion, not the domain type.
`;

/**
 * FALSE FIRE — "same file" as a CITATION idiom inside a mechanism description.
 *
 * Transcript `5e836748-6054-424b-a618-25cd52e620fd.jsonl:296`, `tasks_spec_patch`
 * on mt#4231, cites no PR at all.
 *
 * `(same file, line 43)` is how this corpus cross-references a second symbol in a
 * file it just named. Nothing collides with anything, and — the discriminating
 * property — the paragraph names no COUNTERPARTY: no PR, no other task, no other
 * branch. A collision is a relation between two pieces of work; a paragraph that
 * names only one of them is not asserting one.
 */
export const CITATION_IDIOM_MT4231 = `1. **Historical — the DB snapshot.** \`buildSessionContextSnapshot\`
   (\`packages/domain/src/transcripts/session-context-snapshot.ts:200-235\`) reads
   \`agent_transcripts.transcript\` jsonb AND \`agent_transcript_attachments\`, ordered by
   \`line_index\`, and MERGES them into one block stream. Hook records DO reach the view on this
   path. \`mapAttachmentTypeToBlockType\` (same file, line 43) maps \`hook_additional_context\` →
   \`hook-injection\`.
2. **Live — the SSE tail of the JSONL on disk.** \`jsonlLineToLiveBlock\` / \`turnLineToBlock\`
   (\`src/cockpit/live-tail-poller.ts:157-181\`) return \`null\` for \`attachment\` and \`system\` lines,
   so hook records are dropped for anything appended after the snapshot was taken.
`;

/**
 * FALSE FIRE — a gate-(g) verdict block: the recorded OUTPUT of the very check
 * this guard demands.
 *
 * Transcript `c1b904ea-714b-46b2-89e5-ce7ee654717c.jsonl:3662`, `tasks_spec_patch`
 * on mt#4275.
 *
 * The dominant false class, and the one ADR-024's Rung 1 names outright as
 * "explicit discussion-framing". Note it even opens with a DENIAL — "No parallel
 * work." — which the overlap-denial regex misses because no overlap-noun follows
 * within its window.
 */
export const GATE_VERDICT_BLOCK_MT4275 = `- **(a)** All five sections present. PASS.
- **(b)** Each criterion is a unit assertion or a recorded decision. PASS.
- **(c)** In scope / Out of scope explicit, with the \`ps\` question named as out. PASS.
- **(d)** The one open question — the test's disposition — is now resolved to a recommendation
  above rather than left open. PASS.
- **(e)** Refs verified this session against the working tree: \`port-recovery.ts:301-331\` (the
  guard, quoted), \`:411-412\` (the consumer, \`parseElapsedSeconds\` then
  \`Date.now() - elapsedSec * 1000\`), \`port-incumbent.test.ts:186-200\` (the live-host probe, with
  \`:190\` corrected above as the assertion that actually fails post-fix). PASS.
- **(f)** Single-phase. PASS.
- **(g)** No parallel work. \`git_log --path src/cockpit/port-recovery.ts --since "3 days ago"\`
  returns four commits, all merged: mt#4260's guard (\`1a543d829\`, the subject here) and three from
  mt#4205. No open PR touches the file — the open set was read this session, and this session's own
  PR #3119 changes only \`.github/workflows/cockpit-preview.yml\`. **mt#3733** (TODO) is the nearest
  active task in the module and is reconciled in the duplicate-check record: same file family,
  different function (\`classifyPortHolder\` vs \`processStartedAtMs\`) and different test file
  (\`port-recovery.test.ts\` vs \`port-incumbent.test.ts\`). PASS.
`;

/**
 * FALSE FIRE — a markdown gate table.
 *
 * Transcript `475d9630-8b5b-4776-ae6a-ae0f7b516162.jsonl:363`, `tasks_spec_patch`
 * on mt#4281. Tabulated verdicts are a record of checks, never a claim.
 */
export const GATE_VERDICT_TABLE_MT4281 = `| gate | verdict | note |
| --- | --- | --- |
| (a) required sections | PASS | all five present |
| (f) subtasks | PASS | single phase by construction — this IS mt#1897's phase 1 |
| (g) parallel work | PASS (partial collision, resolved) | PR #774 on \`review-worker.test.ts\`; clear files enumerated in (iii); proceed on the non-overlapping surface |
`;

/**
 * FALSE FIRE — a premise audit written as ONE run-on paragraph.
 *
 * Transcript `19504101-0d14-4fe9-9d6a-02cc81367209.jsonl:691`,
 * `tasks_spec_search_replace` on mt#4291, cites no PR.
 *
 * The same record as the bulleted gate block, in different typography: the
 * `(i)`/`(ii)`/`(iii)`/`(iv)` markers are INLINE, so a line-anchored test sees
 * none of them. It even reports its collision in the past tense as resolved —
 * "was removed by narrowing scope rather than negotiated".
 */
export const INLINE_PREMISE_AUDIT_MT4291 = `**Premise audit.** (i) No open premises: the principal's direction is recorded and closed at
ask#8878, and the evidence base is mt#2531's Findings with its confidence flags intact — the one
ungrounded number (15-turn handoff cost) is labelled as such in the threshold note rather than
carried as settled. (ii) No inherited categorization: "display-only" is the principal's own
constraint, not a classifier verdict. (iii) Overlap searched and reconciled — see the duplicate-check
record; the one live collision (\`transcript.ts\`, mt#2544 IN-PROGRESS) was removed by narrowing scope
rather than negotiated. (iv) Not a recurring patch: this is the first mechanism of its kind, and the
structural reframe already happened upstream (the premise moved from "detect rot" to "show the
number"), recorded in mt#2531.
`;

/**
 * FALSE FIRE — an overlap DENIAL the negation regex cannot see.
 *
 * Transcript `358f1a09-9912-44d6-bbd4-ccf7f6859151.jsonl:471`, `tasks_spec_patch`
 * on mt#4064, cites PR #3070.
 *
 * `OVERLAP_DENIAL_RE` allows up to three intervening `\\w+\\s+` words between the
 * negator and the overlap noun. `generated-file` is one word to a reader and two
 * non-matching tokens to `\\w+`, because `\\w` excludes the hyphen — so the denial
 * is invisible and the paragraph reads as an assertion. A hyphenated compound
 * before "overlap" is ordinary English, not an edge case.
 */
export const HYPHENATED_DENIAL_MT4064 = `- \`bun scripts/build-interceptor-catalog.ts\` → **no diff**. \`Declared but not described: 0 /
  Described but not declared: 0\` holds; the two added recorder effects dedupe into the guard's
  existing \`record\` intervention, so \`src/generated/interceptor-catalog.json\` is byte-identical and
  there is no generated-file overlap with in-flight PR #3070.
`;
