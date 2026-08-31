/**
 * Manifest-coverage check — mt#4804.
 *
 * Answers one question: **is every telemetry stream this repo declares also declared in the
 * ingest manifest?** A stream absent from
 * `packages/domain/src/guard-events/stream-sources.ts` is written to disk forever and reaches
 * `guard_events` never, with no error, no empty result, and no signal of any kind — so nothing
 * notices until somebody diffs the two lists by hand.
 *
 * Somebody did, twice. mt#4752 found three missing streams while enumerating writers it happened
 * to be touching. mt#4804 ran the same enumeration one level wider and found 24 more, holding
 * 107,828 records that had never been ingested. The difference between those two numbers is the
 * argument for this module: hand-enumeration finds what it was already looking at.
 *
 * ## Why declarations, not a filesystem scan
 *
 * The tempting check is to list `.minsky/*-calibration.jsonl` on disk and diff that. It is
 * wrong, and wrong in the direction that reproduces the bug: a scan sees streams that have
 * FIRED. A newly-shipped detector that has not yet fired writes no file, so the scan passes and
 * the stream is missed anyway — the same silent gap through a new mechanism.
 *
 * This is not hypothetical. `criterion-reconciliation` declares an evaluation stream and has
 * never written a record; no file for it exists. A scan reports the set complete. The
 * declaration-based check reports it missing, which it was.
 *
 * The functions here are pure over their inputs so the negative controls can drive them with a
 * synthetic stream rather than by editing the real manifest and putting it back.
 *
 * @see mt#4804 — this task
 * @see ./calibration-log-declarations.ts — the calibration declaration surfaces
 * @see ./evaluation-log-declarations.ts — the evaluation declaration surface
 */

export type StreamFamily = "calibration" | "evaluation";

export interface StreamCoverageInput {
  /** Bare calibration-log names, e.g. `silent-stretch`. */
  readonly declaredCalibrationLogs: readonly string[];
  /** Evaluation stream names AS THE MANIFEST SPELLS THEM, e.g. `silent-stretch-evaluations`. */
  readonly declaredEvaluationStreams: readonly string[];
  /** Every `stream` value in the ingest manifest. */
  readonly manifestStreams: readonly string[];
}

export interface StreamCoverageGap {
  readonly stream: string;
  readonly family: StreamFamily;
}

/**
 * Declared streams that the ingest manifest does not carry.
 *
 * Direction matters and only one direction is a defect. A declared stream missing from the
 * manifest means records are being written and never ingested — the bug. The reverse, a manifest
 * row with no declaration behind it, is at worst a stale row that costs one cheap stat per
 * sweep; {@link findUnbackedManifestStreams} reports it separately so the two are never
 * conflated.
 */
export function findUndeclaredStreams(input: StreamCoverageInput): StreamCoverageGap[] {
  const manifest = new Set(input.manifestStreams);
  const gaps: StreamCoverageGap[] = [];
  for (const stream of input.declaredCalibrationLogs) {
    if (!manifest.has(stream)) gaps.push({ stream, family: "calibration" });
  }
  for (const stream of input.declaredEvaluationStreams) {
    if (!manifest.has(stream)) gaps.push({ stream, family: "evaluation" });
  }
  return gaps.sort((a, b) => a.stream.localeCompare(b.stream));
}

/**
 * Manifest rows no declaration surface accounts for — reported, deliberately not failed.
 *
 * Kept separate from {@link findUndeclaredStreams} because it is a different claim with a much
 * lower cost, and because there are legitimate instances: a stream may be declared somewhere
 * this check does not read yet. Failing on it would make the real direction harder to ship.
 */
export function findUnbackedManifestStreams(input: StreamCoverageInput): string[] {
  const declared = new Set([...input.declaredCalibrationLogs, ...input.declaredEvaluationStreams]);
  return input.manifestStreams.filter((s) => !declared.has(s)).sort();
}

/**
 * Evaluation writers present in the tree but absent from the declaration surface.
 *
 * This is what stops `EVALUATION_STREAM_PRODUCERS` — a hand-maintained map — from falling
 * silently behind the modules that actually write. Adding a writer without an entry fails here.
 */
export function findUndeclaredEvaluationWriters(
  writerModules: readonly string[],
  producers: Readonly<Record<string, string>>
): string[] {
  const declaredModules = new Set(Object.values(producers));
  return writerModules.filter((m) => !declaredModules.has(m)).sort();
}
