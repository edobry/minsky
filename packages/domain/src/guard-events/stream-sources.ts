/**
 * Guard/calibration exhaust stream registry (mt#4035, mt#3334 phase 3).
 *
 * The DATA half of "new stream = config, not code" (constraint carried over
 * from mt#4034's schema doc-comment and the phase-1 inventory). Every row
 * here corresponds 1:1 to a row in
 * `docs/architecture/guard-calibration-stream-inventory.md` §A–§E — the
 * vocabulary (stream names, family names, guard names) is COPIED from that
 * document, never invented here. Adding a newly-appeared stream is adding one
 * entry to {@link GUARD_EVENT_STREAM_SOURCES}; it never requires touching the
 * parsing or ingest orchestration code.
 *
 * Two location kinds:
 *  - `"repo"` — under the repo's `.minsky/` directory (git-tracked, resolved
 *    relative to the repo root via `findRepoRoot`, the same helper the
 *    ask-state/topology cockpit sweeps already use).
 *  - `"state-dir"` — under the runtime state dir (`~/.local/state/minsky/`,
 *    overridable via `MINSKY_STATE_DIR`), the same root the fire-log,
 *    guard-health-log, and the disconnect tracker already write to.
 *
 * mt#4748 (SC1): the `calibration` and `evaluation` families were `"repo"`
 * through 2026-08-30 — every managed project's working tree, not just this
 * repo's, so nothing outside this repo's own `.gitignore` (retired by SC6)
 * ever ignored them. They are `"state-dir"` now, project-keyed under
 * `projects/<hash of repoRoot>/` (see `resolveStreamPath` in
 * `ingest-runtime.ts` and `.minsky/hooks/dispatcher.ts`'s
 * `calibrationLogPath` / `evaluationLogPath`,
 * the actual write path these rows describe) so two Minsky-managed repos on
 * one machine cannot collide in a single flat `<name>-calibration.jsonl`.
 * ADR-028 §D4 is amended in the same change (mt#4748 SC7) — it had
 * documented the now-superseded `.minsky/calibration/<guard>.jsonl` path.
 *
 * mt#4816 finishes it: that amendment was scoped to the calibration/evaluation
 * FAMILY, and `subagent-model-mismatch` (`family: "special"`) was left behind
 * as the last `"repo"` row. It is now state-dir and flat, and `"repo"` is gone
 * from `GuardEventStreamLocation` — so the invariant "nothing writes into a
 * managed project's working tree" is enforced by the type checker rather than
 * by a grep. ADR-028 §D4 carries a second amendment recording that.
 *
 * Two formats:
 *  - `"jsonl"` — newline-delimited JSON, tailed by byte offset (§tailing.ts).
 *  - `"json-array"` — the one exception, `mcp-disconnect-log.json`; parsed
 *    whole-file per tick and watermarked by element count (§parsing.ts).
 *
 * `guardName`, where set, is a STATIC per-stream convenience label (the
 * promoted `guard_events.guard_name` column is nullable and the verbatim
 * `payload` always carries full truth) — copied from the inventory's
 * "Writer (guard / module)" column where it names a guard explicitly in
 * backticks, or defaulted to the stream stem where the row's own writer
 * filename makes that unambiguous (e.g. `wall-of-text-detector.ts` -> guard
 * `wall-of-text`). Left `undefined` wherever the inventory shows two guards
 * sharing one log, no guard at all (non-guard producer), or a family
 * (fire-log / guard-health) whose records carry their OWN `guardName` field
 * per-record — those are handled by generic per-record extraction instead
 * (`extractPromotedFields` in `parsing.ts`).
 *
 * @see docs/architecture/guard-calibration-stream-inventory.md — the source of truth
 * @see packages/domain/src/storage/schemas/guard-events-schema.ts — the table this feeds
 */

export type GuardEventFamily =
  | "calibration"
  | "evaluation"
  | "fire-log"
  | "guard-health"
  | "hook-outcome"
  | "special";

export type GuardEventStreamFormat = "jsonl" | "json-array";

/**
 * Where a stream's file lives. **`"repo"` was retired by mt#4816** — it named the working tree
 * of whichever Minsky-managed project the agent happened to be in, which is the condition
 * mt#4748's SC2 forbids, and `subagent-model-mismatch` was the last row declaring it.
 *
 * The union is deliberately kept (rather than the field being dropped) so each row still states
 * its home explicitly and a future location kind has somewhere to go. Keeping it single-member
 * is what makes the invariant STRUCTURAL: re-introducing a repo-rooted stream is now a type
 * error rather than something a grep has to notice after the fact.
 */
export type GuardEventStreamLocation = "state-dir";

export interface GuardEventStreamSource {
  /** Inventory stream name — the `stream` column value stamped on every ingested row. */
  stream: string;
  family: GuardEventFamily;
  location: GuardEventStreamLocation;
  /**
   * Relative to the state dir. For a `calibration`/`evaluation`-family stream,
   * `resolveStreamPath` additionally nests this under a project-keyed subdirectory
   * (mt#4748) — see the module doc comment. Every other family resolves flat.
   */
  relativePath: string;
  format: GuardEventStreamFormat;
  /** Static per-stream guard label — see module doc comment. */
  guardName?: string;
}

// ---------------------------------------------------------------------------
// §A — calibration-registry streams (.minsky/*-calibration.jsonl)
// ---------------------------------------------------------------------------

const CALIBRATION_STREAMS: GuardEventStreamSource[] = [
  { stream: "agent-dispatch-record", guardName: "record-agent-dispatch" },
  { stream: "ask-form-lint" }, // non-guard producer (asks_create path)
  { stream: "ask-routing-deferral", guardName: "ask-routing-deferral" },
  { stream: "bare-entity-ref", guardName: "bare-entity-ref" },
  { stream: "bare-prohibition", guardName: "bare-prohibition" },
  { stream: "build-claim-injection", guardName: "build-claim-injection" }, // dormant, no file yet
  { stream: "causal-premise", guardName: "causal-premise" },
  { stream: "chained-verification-commands", guardName: "chained-verification-commands" },
  { stream: "block-concurrent-bulk-mutation", guardName: "block-concurrent-bulk-mutation" },
  { stream: "code-mechanism-assertion", guardName: "code-mechanism-assertion" },
  { stream: "constructed-identifier-batch", guardName: "constructed-identifier-batch" },
  {
    stream: "duplicate-check-search-provenance",
    guardName: "duplicate-check-search-provenance",
  },
  { stream: "duplicate-signature-scan", guardName: "duplicate-signature-scan" },
  {
    stream: "execution-evidence-at-coverage",
    guardName: "require-execution-evidence-before-merge",
  },
  {
    stream: "execution-evidence-test-first",
    guardName: "require-execution-evidence-before-merge",
  },
  // mt#4752: the execution-evidence ladder has FIVE tiers, not two. These three
  // were writing to disk and reaching no ingest at all — the manifest listed
  // only the two above, so `guard_events` has never held a record from them.
  //
  // Found while enumerating writers, not by anything watching: a stream absent
  // from this file produces no error and no empty result, it simply never
  // appears. That is why the omission survived — the same shape as the
  // gitignore miss this task's sibling (mt#2492) closed one level down.
  //
  // Each is written by `require-execution-evidence-before-merge.ts`'s own
  // ladder writer via a sibling module: `success-criteria-coverage.ts`,
  // `render-path-evidence.ts` and `consumer-account-evidence.ts` respectively.
  {
    stream: "execution-evidence-sc-coverage",
    guardName: "require-execution-evidence-before-merge",
  },
  {
    stream: "execution-evidence-render-path",
    guardName: "require-execution-evidence-before-merge",
  },
  {
    stream: "execution-evidence-consumer-account",
    guardName: "require-execution-evidence-before-merge",
  },
  { stream: "knowledge-acquisition", guardName: "knowledge-acquisition" },
  { stream: "negative-existence-claim", guardName: "negative-existence-claim-detector" },
  { stream: "operator-deferral" }, // two guards share this log (operator-deferral-detector + -ask-surface)
  { stream: "operator-instruction-trigger", guardName: "substrate-bypass-detector" },
  // Producer RETIRED 2026-08-16 (mt#4197): the policy-coverage detector is deleted, so this
  // stream gains no new records. The row stays because the 1,760-record log is deliberately
  // retained on disk as the retirement's evidence, and this registry's 1:1 correspondence with
  // the inventory doc (which marks the same row retired) is the invariant that keeps the two
  // readable together. Ingest of the historical tail is unaffected.
  { stream: "policy-coverage", guardName: "policy-coverage" },
  { stream: "pre-narration", guardName: "pre-narration" },
  { stream: "retrospective-completeness", guardName: "retrospective-completeness" },
  { stream: "retrospective-trigger" }, // two guards share this log (scanner + turn-end-retro-scan)
  { stream: "silent-stretch", guardName: "silent-stretch" },
  // Producer RETIRED 2026-09-04 (mt#4978, per ask#11629): `stop-at-decision-scan` is deleted, so
  // this stream gains no new records. The row stays for the same reason `policy-coverage`'s does
  // above — the log is deliberately retained on disk as the retirement's evidence (three
  // calibration windows measuring 82% -> 92% -> ~85% false ARE the justification), and
  // `getDeclaredCalibrationLogNames()` deliberately counts a retired producer as a DECLARATION
  // (mt#4204), so removing the row makes the stream declared-but-unmanifested and fails
  // `stream-manifest-coverage`. Ingest of the historical tail is unaffected.
  { stream: "stop-at-decision", guardName: "stop-at-decision" },
  { stream: "unescalated-incident", guardName: "turn-end-unescalated-incident-scan" },
  { stream: "untaken-action", guardName: "untaken-action" },
  { stream: "unwalked-task", guardName: "turn-end-unwalked-task-scan" },
  { stream: "wall-of-text", guardName: "wall-of-text" },
  // mt#4804: the twenty-two below were declared as calibration logs — on the
  // registry, on the standalone-canary surface, or both — and were absent from
  // THIS manifest, so the ingest never walked them. 107,828 records across the
  // whole gap existed only as files.
  //
  // This is mt#4752's finding at its real size. That task found three by
  // enumerating the writers it happened to be touching and wrote the comment
  // above about a stream absent from this file producing no error and no empty
  // result. The diagnosis was exact; the population was 8x larger, because
  // enumerating writers by hand is the same method that missed them.
  //
  // The generalizable fix is not this list — it is
  // `scripts/lib/stream-manifest-coverage.test.ts`, which diffs the declaration
  // surfaces against this manifest so a 23rd omission fails a check. The list is
  // just what that diff returned the first time it was run.
  //
  // guardName is taken from `buildCalibrationLogToGuards()`, not from the stream
  // stem: the two differ for several of these (`stale-state-assertion` is written
  // by `turn-end-stale-state-assertion-scan`, `unwired-task-relationship` by
  // `warn-unwired-task-relationship`), and name-matching is exactly the first
  // pass mt#3502 recorded as wrong.
  { stream: "block-bulk-process-kill", guardName: "block-bulk-process-kill" },
  { stream: "claim-provenance-scan", guardName: "claim-provenance-scan" },
  { stream: "cli-mcp-substitution", guardName: "cli-mcp-substitution" },
  { stream: "context-fill-gauge", guardName: "context-fill-gauge" },
  { stream: "coverage-claim-path", guardName: "coverage-claim-path-detector" },
  { stream: "criterion-reconciliation", guardName: "criterion-reconciliation-scan" },
  { stream: "cross-turn-hedge", guardName: "cross-turn-hedge-detector" },
  { stream: "duplicate-check-candidate-read", guardName: "duplicate-check-candidate-read" },
  { stream: "enumeration-scope", guardName: "enumeration-scope-check" },
  { stream: "evidence-record-provenance", guardName: "evidence-record-provenance" },
  { stream: "flakiness-control", guardName: "flakiness-control-detector" },
  { stream: "gate-walk-provenance", guardName: "gate-walk-provenance" },
  { stream: "new-surface-design-pass", guardName: "new-surface-design-pass" },
  { stream: "nonexistent-search-path", guardName: "nonexistent-search-path" },
  { stream: "secret-request-in-chat", guardName: "secret-request-in-chat-detector" },
  { stream: "spec-criterion-claim", guardName: "spec-criterion-claim-detector" },
  { stream: "spec-scope-execution", guardName: "spec-scope-execution-check" },
  { stream: "stale-signal-sweep", guardName: "stale-signal-sweep" },
  { stream: "stale-state-assertion", guardName: "turn-end-stale-state-assertion-scan" },
  { stream: "truncated-outcome-read", guardName: "truncated-outcome-read" },
  { stream: "unrendered-result-field-scan", guardName: "unrendered-result-field-scan" },
  { stream: "unwired-task-relationship", guardName: "warn-unwired-task-relationship" },
].map((s) => ({
  ...s,
  family: "calibration" as const,
  // mt#4748 SC1: state-dir, not repo — see the module doc comment's history
  // note. `relativePath` is bare (no `.minsky/` prefix): `resolveStreamPath`
  // roots calibration/evaluation streams under a project-keyed subdirectory
  // of the state dir, not the repo, so a `.minsky/`-shaped path would be
  // misleading here.
  location: "state-dir" as const,
  relativePath: `${s.stream}-calibration.jsonl`,
  format: "jsonl" as const,
}));

// ---------------------------------------------------------------------------
// §B — evaluation streams (.minsky/*-evaluations.jsonl)
// ---------------------------------------------------------------------------

const EVALUATION_STREAMS: GuardEventStreamSource[] = [
  // mt#4807: the actionables-decision family records EVERY located terminal
  // actionables block, fired or not, so a sweep has a denominator. It shares
  // the detector's calibration stream NAME; `logEvaluationRecord` derives the
  // `-evaluations` path from it.
  { stream: "ask-routing-deferral-evaluations", guardName: "ask-routing-deferral" },
  { stream: "causal-premise-evaluations", guardName: "causal-premise" },
  {
    stream: "negative-existence-claim-evaluations",
    guardName: "negative-existence-claim-detector",
  },
  { stream: "operator-deferral-evaluations" },
  { stream: "retrospective-trigger-evaluations" },
  { stream: "silent-stretch-evaluations", guardName: "silent-stretch" },
  // mt#4804: the five below were the evaluation half of the same gap.
  //
  // They were harder to find than their calibration siblings, and the reason is
  // worth recording: there is no `evaluationLog:` field anywhere. A calibration
  // stream is declared ON a surface (`GUARD_REGISTRY[].calibrationLog`, a
  // standalone canary, or one of the two explicit producer maps), so it can be
  // enumerated. An evaluation stream is named by a module-local constant that
  // each writer passes to `logEvaluationRecord` — nothing collects them, and
  // `grep -c "evaluationLog:"` over `.minsky/hooks/` returns 0, which reads as
  // "no such thing" rather than "declared differently".
  //
  // `scripts/lib/evaluation-log-declarations.ts` is now that missing surface, and
  // its census test fails when a writer is added without an entry — so this half
  // is enumerable the way the calibration half already was.
  //
  // `criterion-reconciliation-evaluations` has NEVER been written: no file exists
  // for it on disk. It is here because the declaration surface names it, and it
  // is the concrete case for why this task rejected a filesystem scan — a scan
  // sees what has FIRED, so it would have passed while this stream stayed
  // invisible until its first fire.
  { stream: "context-fill-gauge-evaluations", guardName: "context-fill-gauge" },
  {
    stream: "criterion-reconciliation-evaluations",
    guardName: "criterion-reconciliation-scan",
  },
  { stream: "cross-turn-hedge-evaluations", guardName: "cross-turn-hedge-detector" },
  {
    stream: "secret-request-in-chat-evaluations",
    guardName: "secret-request-in-chat-detector",
  },
  { stream: "spec-criterion-claim-evaluations", guardName: "spec-criterion-claim-detector" },
  // mt#4117: the untaken-action family's evaluation stream, armed alongside
  // its existing fire-only calibration log (`untaken-action-calibration.jsonl`).
  { stream: "untaken-action-evaluations", guardName: "turn-end-untaken-action-scan" },
].map((s) => ({
  ...s,
  family: "evaluation" as const,
  // mt#4748 SC1: state-dir, not repo — see CALIBRATION_STREAMS above for the
  // rationale (identical: `resolveStreamPath` project-keys this family).
  location: "state-dir" as const,
  relativePath: `${s.stream}.jsonl`,
  format: "jsonl" as const,
}));

// ---------------------------------------------------------------------------
// §C — non-guard special stream
// ---------------------------------------------------------------------------
//
// mt#4816: this was the last `location: "repo"` row. It is now state-dir and FLAT — NOT
// project-keyed — which puts it with `fire-log` and `guard-health-log` in §D rather than with
// the calibration streams it used to sit beside on disk. The reason is that `project_id` is
// resolved from each record's `session_id` by `attachProjectIds` (`ingest-service.ts`) and never
// from the file path, so project-keying the path would buy no attribution the row does not
// already carry. The writer is `.minsky/hooks/verify-subagent-model.ts`, whose `MISMATCH_LOG` is
// asserted byte-identical to the `relativePath` below.

const SPECIAL_STREAMS: GuardEventStreamSource[] = [
  {
    stream: "subagent-model-mismatch",
    family: "special",
    location: "state-dir",
    relativePath: "subagent-model-mismatch.jsonl",
    format: "jsonl",
  },
];

// ---------------------------------------------------------------------------
// §D — state-dir guard/calibration streams
// ---------------------------------------------------------------------------

const STATE_DIR_STREAMS: GuardEventStreamSource[] = [
  {
    stream: "fire-log",
    family: "fire-log",
    location: "state-dir",
    relativePath: "fire-log.jsonl",
    format: "jsonl",
    // guardName intentionally unset — every fire-log record carries its OWN
    // `guardName` field; the promoted column is extracted per-record.
  },
  {
    stream: "guard-health-log",
    family: "guard-health",
    location: "state-dir",
    relativePath: "guard-health-log.jsonl",
    format: "jsonl",
    // guardName intentionally unset — same reason as fire-log.
  },
  {
    stream: "two-strikes-observations",
    family: "special",
    location: "state-dir",
    relativePath: "two-strikes/observations.jsonl",
    format: "jsonl",
  },
];

// ---------------------------------------------------------------------------
// §E — adjacent state-dir streams classified IN (mcp-disconnect-log,
// transcript-ingest-hook-log, session-link-hook-failures,
// conversation-transitions). credential-scrub-log is classified OUT and is
// deliberately absent.
// ---------------------------------------------------------------------------

const ADJACENT_STATE_DIR_STREAMS: GuardEventStreamSource[] = [
  {
    stream: "mcp-disconnect-log",
    family: "special",
    location: "state-dir",
    relativePath: "mcp-disconnect-log.json",
    format: "json-array",
  },
  {
    stream: "transcript-ingest-hook-log",
    family: "hook-outcome",
    location: "state-dir",
    relativePath: "transcript-ingest-hook-log.jsonl",
    format: "jsonl",
  },
  {
    stream: "session-link-hook-failures",
    family: "hook-outcome",
    location: "state-dir",
    relativePath: "session-link-hook-failures.jsonl",
    format: "jsonl",
  },
  {
    stream: "conversation-transitions",
    family: "special",
    location: "state-dir",
    relativePath: "conversation-transitions.jsonl",
    format: "jsonl",
  },
];

// ---------------------------------------------------------------------------
// Deliberately ABSENT: the unasked-direction store (mt#4778)
// ---------------------------------------------------------------------------
//
// `~/.local/state/minsky/unasked-directions/` and its `-signatures/` sibling are
// state-dir stores under this file's roots, and they have NO row here on purpose.
// Recorded so the next person who notices the gap does not "fix" it — an absence
// with no reason is indistinguishable from an oversight, which is what let the
// store go unmanifested through mt#4752 and mt#4748 in the first place.
//
// A row is not EXPRESSIBLE, not merely unwanted. `relativePath` names one FILE:
// `resolveStreamPath` joins it onto the state dir and `realReadTail` calls
// `existsSync` → `statSync().size` → a byte-offset tail read on the result. These
// stores are DIRECTORIES of per-session JSON files that are OVERWRITTEN in place
// (the analyzer re-runs; the operator assigns a verdict), so a row would be
// type-valid and mis-resolved: a directory `statSync`s fine and tail-reads to
// nothing. Ingest is watermark-based and has no "since" to read from a value that
// is replaced rather than appended.
//
// mt#4778's own SC4 asked for a row here; its `## Success Criteria` records why
// that criterion was wrong. The store is classified in
// `docs/architecture/guard-calibration-stream-inventory.md` §F (mutable state
// stores, state-not-stream, out of ingest scope) beside `two-strikes/`'s
// per-conversation files, which are the same shape.
//
// What would change this: making the manifest able to express a directory-of-
// records source, which is a schema decision for the ingest, not a row.

/**
 * The complete guard/calibration exhaust stream set — every row from
 * inventory §A–§E. The count is deliberately NOT written here: this comment
 * said "41 streams as of the 2026-08-13 snapshot" while the array held 46 and
 * the repo declared 73, and a number that drifts silently is worse than no
 * number, because it reads as current. `GUARD_EVENT_STREAM_SOURCES.length` is
 * the count, and `scripts/lib/stream-manifest-coverage.test.ts` is what keeps
 * the set correct (PR #3517 R1). This IS the
 * "data, not code" surface constraint #8 requires: a newly-appeared stream
 * is a new entry here, never a change to `parsing.ts` or `ingest-service.ts`.
 */
export const GUARD_EVENT_STREAM_SOURCES: readonly GuardEventStreamSource[] = [
  ...CALIBRATION_STREAMS,
  ...EVALUATION_STREAMS,
  ...SPECIAL_STREAMS,
  ...STATE_DIR_STREAMS,
  ...ADJACENT_STATE_DIR_STREAMS,
];
