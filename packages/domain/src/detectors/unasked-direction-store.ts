/**
 * Findings + signature-seed file store — Surface 4 of the System 3* detector.
 *
 * Persists analyzer findings and operator-promoted signature seeds to local
 * JSON files. v0.1 storage layout:
 *
 *   .minsky/state/unasked-directions/<sessionId>.json
 *     One record per session: the analyzer's full output, status (pending /
 *     reviewed), and any operator-applied verdicts.
 *
 *   .minsky/state/unasked-direction-signatures/<sessionId>.json
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
import type { AnalyzerOutput, UnaskedDirectionFinding } from "./unasked-direction-analyzer";
import { DETECTOR_ID, DETECTOR_VERSION } from "./unasked-direction-analyzer";
import { log } from "@minsky/shared/logger";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Root directory under repo for findings (per-session JSON). */
export const FINDINGS_DIR = ".minsky/state/unasked-directions";

/** Root directory under repo for signature seeds (per-session JSON). */
export const SIGNATURES_DIR = ".minsky/state/unasked-direction-signatures";

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
  output: AnalyzerOutput,
  context: { taskId?: string }
): Promise<boolean> {
  const path = findingsPathFor(projectRoot, sessionId);

  const record: FindingsRecord = {
    detectorId: DETECTOR_ID,
    detectorVersion: DETECTOR_VERSION,
    sessionId,
    taskId: context.taskId,
    analyzedAt: new Date().toISOString(),
    summary: output.summary,
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
