/**
 * Findings + signature-seed file store — Surface 4 of the System 3* detector.
 *
 * Persists analyzer findings and operator-promoted signature seeds to local
 * JSON files. v0.1 storage layout:
 *
 *   <state dir>/unasked-directions/<sessionId>.json
 *     One record per session: the analyzer's full output, status (pending /
 *     reviewed), and any operator-applied verdicts.
 *
 *   <state dir>/unasked-direction-signatures/<sessionId>.json
 *     Signature seeds — entries appended when the operator marks a finding
 *     as a real direction. Surface 2 (mt#TBD, future) consumes this corpus.
 *
 * All file IO is wrapped in try/catch with safe defaults (empty / null) so
 * the post-merge hook is never blocked by storage failures. Per-session
 * isolation: writers create one file per session; the weekly review CLI
 * walks the directory.
 *
 * Reference: docs/research/mt1035-system3-detector.md §Surface 4
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AnalyzerOutput,
  TranscriptSampling,
  UnaskedDirectionFinding,
} from "./unasked-direction-analyzer";
import { DETECTOR_ID, DETECTOR_VERSION } from "./unasked-direction-analyzer";
import { log } from "@minsky/shared/logger";
import { getMinskyStateDir } from "@minsky/shared/paths";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Findings subdirectory, relative to the store root (per-session JSON). */
export const FINDINGS_DIR = "unasked-directions";

/** Signature-seed subdirectory, relative to the store root (per-session JSON). */
export const SIGNATURES_DIR = "unasked-direction-signatures";

/**
 * The root both stores live under — `<state dir>/`, NOT the repo working tree.
 *
 * mt#4778: these two directories were `<projectRoot>/.minsky/state/...`, where
 * `projectRoot` came from `findRepoRoot(input.cwd)`. A post-merge run invoked
 * from a session workspace therefore wrote into that CLONE, while
 * `unasked-direction_list` — the only reader — resolved a single root. Measured
 * before the fix: **13 findings across 5 session clones** the triage tool could
 * not see, and each one dies with its workspace on `session_delete`.
 *
 * FLAT, not project-keyed, and that is deliberate. mt#4748 project-keys the
 * `calibration` and `evaluation` families only (`resolveStreamPath` in
 * `guard-events/ingest-runtime.ts`); every other state-dir stream — `fire-log`,
 * `guard-health-log`, and now this one — stays flat, which mt#4816 confirmed
 * when it placed `subagent-model-mismatch` the same way. Session ids are
 * globally unique, so a flat directory cannot collide across projects.
 *
 * **Resolution deviates from SC1 as written, deliberately.** SC1 asks for
 * `MINSKY_STATE_DIR` → `XDG_STATE_HOME/minsky` → `~/.local/state/minsky`. This
 * uses the shared `getMinskyStateDir()` instead, which omits the first tier —
 * `packages/shared/src/paths.ts` documents why in its own docblock: adding
 * `MINSKY_STATE_DIR` as a higher-precedence tier there "looks like unification
 * and is not", because seven test files isolate themselves by overriding
 * `XDG_STATE_HOME` around a temp dir and a global `MINSKY_STATE_DIR` would
 * silently outrank every one of them (measured: 24 tests across 7 files fail).
 * Hand-rolling that precedence HERE would recreate exactly the divergence that
 * docblock exists to prevent, and would make this the eleventh hand-rolled
 * resolver. `tests/setup.ts` sets both variables anyway (mt#3965), so isolation
 * is unaffected. Recorded in the spec's `## Implementation findings`.
 */
export function resolveUnaskedDirectionRoot(): string {
  return getMinskyStateDir();
}

/**
 * Resolve the per-session findings file path.
 *
 * `<projectRoot>/.minsky/state/unasked-directions/<sessionId>.json`
 */
export function findingsPathFor(projectRoot: string, sessionId: string): string {
  return join(projectRoot, FINDINGS_DIR, `${sanitizeSessionId(sessionId)}.json`);
}

/**
 * Resolve the per-session signature-seed file path.
 *
 * `<projectRoot>/.minsky/state/unasked-direction-signatures/<sessionId>.json`
 */
export function signaturesPathFor(projectRoot: string, sessionId: string): string {
  return join(projectRoot, SIGNATURES_DIR, `${sanitizeSessionId(sessionId)}.json`);
}

/**
 * Make a session ID safe for use as a filename.
 *
 * Strips path separators and other characters that could escape the directory.
 * Conservative — accepts only alphanumerics, dashes, underscores, and `#`.
 */
function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_\-#]/g, "_");
}

// ---------------------------------------------------------------------------
// Findings record
// ---------------------------------------------------------------------------

/** Per-finding verdict assigned by the operator during weekly review. */
export type FindingVerdict = "pending" | "real" | "false-positive";

/** A finding as stored on disk: the analyzer output plus a stable index + verdict. */
export interface StoredFinding {
  /** Stable id within the session: 0-based index in the analyzer's findings array. */
  findingIndex: number;
  /** The analyzer's raw finding record. */
  finding: UnaskedDirectionFinding;
  /** Operator verdict; `pending` until reviewed. */
  verdict: FindingVerdict;
  /** Optional operator note attached at verdict time. */
  note?: string;
  /** ISO timestamp when verdict was applied (`undefined` while pending). */
  reviewedAt?: string;
}

/** Top-level shape persisted to `<sessionId>.json` under findings dir. */
export interface FindingsRecord {
  detectorId: string;
  detectorVersion: string;
  sessionId: string;
  taskId?: string;
  /** ISO timestamp of analyzer run. */
  analyzedAt: string;
  /** Analyzer's overall summary. */
  summary: string;
  /**
   * How the analyzed window was chosen (mt#4235).
   *
   * Optional because records written before mt#4235 do not have it, and a reader must be
   * able to tell "this run predates the measurement" from "this run measured zero". A
   * record with no `sampling` is one whose window shape is simply unknown.
   */
  sampling?: TranscriptSampling;
  /**
   * Set when the analyzer call FAILED and produced no findings (mt#4235).
   *
   * A failed run used to write nothing at all, so the corpus contained only the runs that
   * succeeded — and anyone counting "N sessions analyzed, 0 findings" was reading a
   * denominator that had silently dropped its failures. `findings: []` with this field set
   * means "no answer"; `findings: []` without it means "analyzed, found nothing". Those
   * are different results and the record has to be able to say which.
   */
  analyzerError?: string;
  /** All findings, indexed in insertion order. */
  findings: StoredFinding[];
}

// ---------------------------------------------------------------------------
// Findings IO
// ---------------------------------------------------------------------------

/**
 * Write a fresh findings record for a session.
 *
 * Overwrites any existing record for the same session — we run once per
 * session merge, so re-runs (e.g. retried merges) replace the prior pass.
 *
 * Safe on IO error: logs and returns `false`. The hook treats `false` as
 * "log only" and continues.
 */
export async function writeFindings(
  projectRoot: string,
  sessionId: string,
  output: AnalyzerOutput & { sampling?: TranscriptSampling },
  context: { taskId?: string },
  analyzerError?: string
): Promise<boolean> {
  const path = findingsPathFor(projectRoot, sessionId);

  const record: FindingsRecord = {
    detectorId: DETECTOR_ID,
    detectorVersion: DETECTOR_VERSION,
    sessionId,
    taskId: context.taskId,
    analyzedAt: new Date().toISOString(),
    summary: output.summary,
    // Carried through from the analyzer run rather than re-derived here: the store has no
    // transcript, and a second derivation could describe a different window than the one
    // the model read (mt#4235 SC4).
    sampling: output.sampling,
    analyzerError,
    findings: output.findings.map((finding, findingIndex) => ({
      findingIndex,
      finding,
      verdict: "pending" as const,
    })),
  };

  try {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, JSON.stringify(record, null, 2), "utf-8");
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("unasked-direction-store: failed to write findings", {
      path,
      sessionId,
      error: message,
    });
    return false;
  }
}

/**
 * Record a run whose analyzer call FAILED, so the corpus keeps its denominator.
 *
 * Same file, same shape, no findings — plus `analyzerError` and the sampling the run WOULD
 * have analyzed. Without this a failure is invisible: the hook logged to stderr and exited,
 * leaving nothing on disk, so a corpus reader saw only the successes (mt#4235).
 */
export async function writeFailedRun(
  projectRoot: string,
  sessionId: string,
  sampling: TranscriptSampling,
  error: string,
  context: { taskId?: string }
): Promise<boolean> {
  return writeFindings(
    projectRoot,
    sessionId,
    {
      findings: [],
      summary: `Analyzer call failed; no findings were produced. ${error}`,
      sampling,
    },
    context,
    error
  );
}

/**
 * Read a findings record for a session, or `null` if missing/unreadable.
 */
export async function readFindings(
  projectRoot: string,
  sessionId: string
): Promise<FindingsRecord | null> {
  const path = findingsPathFor(projectRoot, sessionId);
  try {
    const raw = String(await fs.readFile(path, "utf-8"));
    return JSON.parse(raw) as FindingsRecord;
  } catch {
    return null;
  }
}

/**
 * List all session IDs that have a findings record under the project's
 * findings dir. Returns `[]` if the dir is missing or unreadable.
 */
export async function listFindingsSessions(projectRoot: string): Promise<string[]> {
  const dir = join(projectRoot, FINDINGS_DIR);
  try {
    const entries = await fs.readdir(dir);
    return entries.filter((e) => e.endsWith(".json")).map((e) => e.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

/**
 * Update a single finding's verdict and write the record back.
 *
 * Returns `true` on success, `false` if the session record is missing or
 * the finding index is out of bounds.
 */
export async function updateFindingVerdict(
  projectRoot: string,
  sessionId: string,
  findingIndex: number,
  verdict: Exclude<FindingVerdict, "pending">,
  note?: string
): Promise<boolean> {
  const record = await readFindings(projectRoot, sessionId);
  if (record === null) return false;
  if (findingIndex < 0 || findingIndex >= record.findings.length) return false;

  const target = record.findings[findingIndex];
  if (target === undefined) return false;

  target.verdict = verdict;
  target.note = note;
  target.reviewedAt = new Date().toISOString();

  const path = findingsPathFor(projectRoot, sessionId);
  try {
    await fs.writeFile(path, JSON.stringify(record, null, 2), "utf-8");
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("unasked-direction-store: failed to update verdict", {
      path,
      sessionId,
      findingIndex,
      error: message,
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Signature seeds
// ---------------------------------------------------------------------------

/** A signature seed appended when a finding is marked real. */
export interface SignatureSeed {
  /** Signature string the analyzer suggested. */
  signature: string;
  /** Originating session for traceability. */
  sourceSessionId: string;
  /** Originating finding index for traceability. */
  sourceFindingIndex: number;
  /** ISO timestamp when the seed was promoted. */
  promotedAt: string;
  /** Operator note carried over from the verdict, if any. */
  note?: string;
}

/** Top-level shape persisted to `<sessionId>.json` under signatures dir. */
export interface SignatureSeedRecord {
  detectorId: string;
  detectorVersion: string;
  sessionId: string;
  seeds: SignatureSeed[];
}

/**
 * Append one signature seed to the per-session seeds file. Creates the
 * file (and parent dir) if absent. Safe on IO error — returns `false`.
 *
 * Per spec the durable storage location is re-architected when Surface 2
 * ships; this writer's interface stays the same.
 */
export async function appendSignatureSeed(
  projectRoot: string,
  sessionId: string,
  seed: SignatureSeed
): Promise<boolean> {
  const path = signaturesPathFor(projectRoot, sessionId);

  let record: SignatureSeedRecord;
  try {
    const raw = String(await fs.readFile(path, "utf-8"));
    record = JSON.parse(raw) as SignatureSeedRecord;
  } catch {
    record = {
      detectorId: DETECTOR_ID,
      detectorVersion: DETECTOR_VERSION,
      sessionId,
      seeds: [],
    };
  }

  record.seeds.push(seed);

  try {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, JSON.stringify(record, null, 2), "utf-8");
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("unasked-direction-store: failed to append signature seed", {
      path,
      sessionId,
      error: message,
    });
    return false;
  }
}

/**
 * Read all signature seeds for a session, or `[]` if missing/unreadable.
 */
export async function readSignatureSeeds(
  projectRoot: string,
  sessionId: string
): Promise<SignatureSeed[]> {
  const path = signaturesPathFor(projectRoot, sessionId);
  try {
    const raw = String(await fs.readFile(path, "utf-8"));
    const record = JSON.parse(raw) as SignatureSeedRecord;
    return Array.isArray(record.seeds) ? record.seeds : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const __TEST_ONLY = {
  sanitizeSessionId,
} as const;
