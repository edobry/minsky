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

export type GuardEventStreamLocation = "repo" | "state-dir";

export interface GuardEventStreamSource {
  /** Inventory stream name — the `stream` column value stamped on every ingested row. */
  stream: string;
  family: GuardEventFamily;
  location: GuardEventStreamLocation;
  /**
   * Relative to the repo root (location="repo") or the state dir
   * (location="state-dir"). For a `calibration`/`evaluation`-family
   * state-dir stream, `resolveStreamPath` additionally nests this under a
   * project-keyed subdirectory (mt#4748) — see the module doc comment.
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
  { stream: "stop-at-decision", guardName: "stop-at-decision" },
  { stream: "unescalated-incident", guardName: "turn-end-unescalated-incident-scan" },
  { stream: "untaken-action", guardName: "untaken-action" },
  { stream: "unwalked-task", guardName: "turn-end-unwalked-task-scan" },
  { stream: "wall-of-text", guardName: "wall-of-text" },
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
  { stream: "causal-premise-evaluations", guardName: "causal-premise" },
  {
    stream: "negative-existence-claim-evaluations",
    guardName: "negative-existence-claim-detector",
  },
  { stream: "operator-deferral-evaluations" },
  { stream: "retrospective-trigger-evaluations" },
  { stream: "silent-stretch-evaluations", guardName: "silent-stretch" },
  { stream: "stop-at-decision-evaluations", guardName: "stop-at-decision" },
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

const SPECIAL_REPO_STREAMS: GuardEventStreamSource[] = [
  {
    stream: "subagent-model-mismatch",
    family: "special",
    location: "repo",
    relativePath: ".minsky/subagent-model-mismatch.jsonl",
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

/**
 * The complete guard/calibration exhaust stream set — every row from
 * inventory §A–§E (41 streams as of the 2026-08-13 snapshot). This IS the
 * "data, not code" surface constraint #8 requires: a newly-appeared stream
 * is a new entry here, never a change to `parsing.ts` or `ingest-service.ts`.
 */
export const GUARD_EVENT_STREAM_SOURCES: readonly GuardEventStreamSource[] = [
  ...CALIBRATION_STREAMS,
  ...EVALUATION_STREAMS,
  ...SPECIAL_REPO_STREAMS,
  ...STATE_DIR_STREAMS,
  ...ADJACENT_STATE_DIR_STREAMS,
];
