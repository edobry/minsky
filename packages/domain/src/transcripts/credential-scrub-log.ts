/**
 * credential-scrub-log — counted-signal observability for the tool-output
 * credential scrubber (mt#2763).
 *
 * Why a dedicated append-only JSONL file rather than `@minsky/shared/logger`
 * (`log.warn` / `log.info`): this codebase's `log.*` levels other than
 * `error` NO-OP in HUMAN mode (`packages/shared/src/logger.ts` — "In HUMAN
 * mode (for CLI), suppress ... logs unless explicitly enabled"), and HUMAN
 * is the DEFAULT log mode for CLI invocations — which is exactly how the
 * ingest pipeline runs in production (the SessionEnd hook shells out to
 * `minsky transcripts ingest`, mt#2192). Routing the redaction count through
 * `log.warn` would make it invisible under normal operation, defeating the
 * spec's explicit requirement that over-redaction be visible. Instead this
 * mirrors the established Minsky pattern for exactly this kind of always-on
 * observability signal — the SessionEnd transcript-ingest hook's own
 * `transcript-ingest-hook-log.jsonl` (mt#2192 SC2) and the MCP
 * `mcp-disconnect-log.json` (mt#1645/1682) — an append-only JSONL file under
 * the Minsky state dir that a human or a sweep can grep/jq regardless of
 * `MINSKY_LOG_MODE`.
 *
 * @see mt#2763 — this file
 * @see ./credential-scrubber.ts — produces the `RedactionHit[]` this module logs
 */

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";

import type { RedactionHit } from "./credential-scrubber";

/** Observable JSONL log filename under the minsky state dir. */
export const CREDENTIAL_SCRUB_LOG_FILENAME = "credential-scrub-log.jsonl";

/** One appended log line: the counted signal for a single ingestSession() call. */
export interface CredentialScrubLogRecord {
  timestamp: string;
  agentSessionId: string;
  /** Total redactions across all shapes for this ingest call. */
  redactionCount: number;
  /** Per-shape breakdown — `CredentialShape.name` -> count. Lets an operator see WHICH shape is over-firing. */
  byShape: Record<string, number>;
}

export interface CredentialScrubLogDeps {
  appendLog: (logPath: string, line: string) => void;
  resolveLogPath: () => string;
  now: () => Date;
}

/**
 * Build and append the counted-signal record for one ingest call. No-ops
 * (returns `null`, writes nothing) when `redactions` is empty — the log
 * exists to make NONZERO redaction activity visible, not to record every
 * clean ingest.
 *
 * Logging is best-effort: an `appendLog` failure is swallowed so a disk or
 * permissions issue on the log file can never fail the ingest it's
 * instrumenting (same posture as the SessionEnd hook's `writeRecord`).
 */
export function recordCredentialScrub(
  agentSessionId: string,
  redactions: readonly RedactionHit[],
  deps: CredentialScrubLogDeps
): CredentialScrubLogRecord | null {
  if (redactions.length === 0) {
    return null;
  }

  const byShape: Record<string, number> = {};
  for (const hit of redactions) {
    byShape[hit.shape] = (byShape[hit.shape] ?? 0) + 1;
  }

  const record: CredentialScrubLogRecord = {
    timestamp: deps.now().toISOString(),
    agentSessionId,
    redactionCount: redactions.length,
    byShape,
  };

  try {
    deps.appendLog(deps.resolveLogPath(), `${JSON.stringify(record)}\n`);
  } catch {
    // Best-effort — never let observability logging break ingest.
  }

  return record;
}

function resolveStateDir(env: Record<string, string | undefined>): string {
  const stateDir = env.MINSKY_STATE_DIR;
  return stateDir && stateDir.trim().length > 0
    ? stateDir
    : join(homedir(), ".local", "state", "minsky");
}

/** Resolves `<state-dir>/credential-scrub-log.jsonl`, honoring `MINSKY_STATE_DIR`. */
export function resolveCredentialScrubLogPath(
  env: Record<string, string | undefined> = process.env
): string {
  return join(resolveStateDir(env), CREDENTIAL_SCRUB_LOG_FILENAME);
}

/** Real dependency wiring for production use. */
export const realCredentialScrubLogDeps: CredentialScrubLogDeps = {
  appendLog: (logPath: string, line: string) => {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line);
  },
  resolveLogPath: () => resolveCredentialScrubLogPath(),
  now: () => new Date(),
};
