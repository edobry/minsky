/**
 * Shared evaluation-log declaration accessor — mt#4804.
 *
 * The evaluation-stream twin of `./calibration-log-declarations.ts`, and it exists because that
 * module's four declaration surfaces have no counterpart on this side.
 *
 * A CALIBRATION log's producer is declared ON a surface — `GUARD_REGISTRY[].calibrationLog`,
 * `STANDALONE_GUARD_CANARIES[].calibrationLog`, `NON_GUARD_CALIBRATION_PRODUCERS`, or
 * `RETIRED_CALIBRATION_PRODUCERS` — so the set is enumerable by reading declarations.
 *
 * An EVALUATION log's producer declares nothing. Each writer holds its stream name in a
 * module-local constant and passes it to `logEvaluationRecord`:
 *
 *     const EVALUATION_LOG_NAME = "silent-stretch";
 *     logEvaluationRecord(EVALUATION_LOG_NAME, record, { fallbackCwd: cwd });
 *
 * Nothing collects those constants. `grep -c "evaluationLog:"` over `.minsky/hooks/` returns
 * **0** — which reads as "no such mechanism" rather than "declared some other way", and that
 * misreading is why mt#4804's planning pass recorded the evaluation half as an open question it
 * refused to guess at. Five of the eleven evaluation streams were missing from the ingest
 * manifest and there was no list to diff against.
 *
 * This module is that list. It is deliberately an EXPLICIT enumeration rather than a scan, for
 * the same reason `NON_GUARD_CALIBRATION_PRODUCERS` is: a declaration is a claim someone made,
 * and it can be checked. What keeps it honest is the census in
 * `./stream-manifest-coverage.test.ts`, which reads the hooks tree for modules that actually
 * write evaluation records and fails when one is absent here — so a hand-maintained list cannot
 * silently fall behind the writers, which is the failure ADR-028 §D4 rejects hand-maintained
 * lists for.
 *
 * Lives under `scripts/lib/` for the reason its sibling documents at length: `scripts/` has
 * established precedent for importing directly from `.minsky/hooks/`, and `src/` deliberately
 * does not cross that boundary.
 *
 * @see mt#4804 — this task
 * @see ./calibration-log-declarations.ts — the calibration-side accessor this mirrors
 * @see ./stream-manifest-coverage.test.ts — the census that keeps this list honest
 * @see packages/domain/src/guard-events/stream-sources.ts — the manifest this feeds
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every evaluation-log name, mapped to the module that writes it.
 *
 * The KEY is the bare log name — the value of that module's `EVALUATION_LOG_NAME` constant, the
 * exact string handed to `logEvaluationRecord`. It is NOT the ingest stream name: see
 * {@link evaluationStreamName} for why those differ by a suffix.
 *
 * The VALUE is the repo-relative writer module. It is what the census joins on, so it must be
 * the module containing the `logEvaluationRecord` call, not a helper it delegates to.
 */
export const EVALUATION_STREAM_PRODUCERS: Record<string, string> = {
  "causal-premise": ".minsky/hooks/causal-premise-detector.ts",
  // Writes through an INJECTED alias (`const logEvaluation = deps.logEvaluationRecordFn ??
  // logEvaluationRecord`), so a source scan keyed on the literal call `logEvaluationRecord(`
  // does not see it. The census keys on the IMPORT instead, which is why this one is not a
  // blind spot — it was, for the first pass of mt#4804's own investigation.
  "context-fill-gauge": ".minsky/hooks/context-fill-gauge.ts",
  // Declared and wired, but has never fired: no `criterion-reconciliation-evaluations.jsonl`
  // exists on disk. That is the concrete case for preferring declarations over a filesystem
  // scan — a scan of written logs sees what has FIRED, so it would report this set complete.
  "criterion-reconciliation": ".minsky/hooks/criterion-reconciliation-scan.ts",
  "cross-turn-hedge": ".minsky/hooks/cross-turn-hedge-detector.ts",
  "negative-existence-claim": ".minsky/hooks/negative-existence-claim-detector.ts",
  "operator-deferral": ".minsky/hooks/operator-deferral-detector.ts",
  "retrospective-trigger": ".minsky/hooks/retrospective-trigger-scanner.ts",
  "secret-request-in-chat": ".minsky/hooks/secret-request-in-chat-detector.ts",
  "silent-stretch": ".minsky/hooks/silent-stretch-detector.ts",
  "spec-criterion-claim": ".minsky/hooks/spec-criterion-claim-detector.ts",
  "stop-at-decision": ".minsky/hooks/stop-at-decision-scan.ts",
};

/**
 * The ingest stream name for an evaluation log.
 *
 * The two differ, and the difference is load-bearing rather than cosmetic. `evaluationLogPath`
 * (`.minsky/hooks/dispatcher.ts`) builds `${evaluationLogName}-evaluations.jsonl`, so the file
 * for log `silent-stretch` is `silent-stretch-evaluations.jsonl` — and the manifest's
 * `EVALUATION_STREAMS` rows carry the SUFFIXED form as their `stream`, because their
 * `relativePath` is the bare `${stream}.jsonl`.
 *
 * Several streams therefore appear twice in the manifest under near-identical names — a
 * `silent-stretch` calibration row and a `silent-stretch-evaluations` evaluation row — which is
 * exactly the kind of pair a hand-comparison gets wrong in one direction and not the other.
 */
export function evaluationStreamName(logName: string): string {
  return `${logName}-evaluations`;
}

/** Every declared evaluation-log name, sorted. Mirrors `getDeclaredCalibrationLogNames()`. */
export function getDeclaredEvaluationLogNames(): string[] {
  return Object.keys(EVALUATION_STREAM_PRODUCERS).sort();
}

/** Every declared evaluation stream name as the ingest manifest spells it, sorted. */
export function getDeclaredEvaluationStreamNames(): string[] {
  return getDeclaredEvaluationLogNames().map(evaluationStreamName);
}

/** Filesystem reads the writer census needs, injected so the census is testable. */
export interface EvaluationWriterScanDeps {
  listHookFiles: () => string[];
  readFile: (path: string) => string;
}

/** Repo-relative hooks directory the census reads by default. */
export const HOOKS_DIR = ".minsky/hooks";

/**
 * Real-filesystem deps for {@link findEvaluationWriterModules}.
 *
 * Deliberately lives HERE rather than in the test that consumes it. The census has to read the
 * hooks tree — that is the whole point of a census — but `custom/no-real-fs-in-tests` is scoped
 * to `**\/*.test.ts`, and this repo's ESLint gate admits no warnings. Owning the IO in the
 * module keeps the test a pure consumer of injected deps, which is the shape the rule is asking
 * for anyway.
 *
 * `repoRoot` defaults to this file's own location (`scripts/lib` -> two levels up), so the
 * census does not depend on the process working directory.
 */
export function defaultEvaluationWriterScanDeps(repoRoot?: string): EvaluationWriterScanDeps {
  const root = repoRoot ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const hooksDir = join(root, HOOKS_DIR);
  return {
    listHookFiles: () =>
      readdirSync(hooksDir)
        .filter((f) => f.endsWith(".ts"))
        .map((f) => `${HOOKS_DIR}/${f}`),
    readFile: (path: string) => readFileSync(join(root, path), "utf8"),
  };
}

/**
 * Every `.minsky/hooks` module that writes evaluation records, found by reading source.
 *
 * Keys on the IMPORT of `logEvaluationRecord`, not on a call to it. That choice is the whole
 * point of the function: `context-fill-gauge.ts` calls the writer through an injected alias
 * (`logEvaluation(...)`), so a scan for `logEvaluationRecord(` finds ten writers and misses the
 * eleventh — which is what happened during mt#4804's investigation, and the miss is silent
 * because ten results look like a complete answer.
 *
 * Test files are excluded (they import the writer to assert on it), as is `dispatcher.ts`, which
 * DEFINES it.
 */
export function findEvaluationWriterModules(deps: EvaluationWriterScanDeps): string[] {
  const writers: string[] = [];
  for (const path of deps.listHookFiles()) {
    if (path.endsWith(".test.ts")) continue;
    if (path.endsWith("/dispatcher.ts") || path.endsWith("dispatcher.ts")) continue;
    const source = deps.readFile(path);
    // The import, not the call — see the doc comment above.
    if (!/import\s*\{[^}]*\blogEvaluationRecord\b[^}]*\}\s*from/s.test(source)) continue;
    writers.push(path);
  }
  return writers.sort();
}
