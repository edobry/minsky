/**
 * Guard/calibration exhaust ingest orchestration (mt#4035, mt#3334 phase 3).
 *
 * Pure with respect to injected deps ({@link GuardEventsIngestDeps}) — no
 * direct `fs`/DB access here, so this is unit-testable with in-memory fakes
 * (testable-design; no `spyOn` on module imports). Real wiring (`fs`,
 * Drizzle, project-id resolution) lives in `ingest-runtime.ts`.
 *
 * ## THE SWEEP IS THE CORRECTNESS LAYER
 *
 * This function is called from two invocation paths — the SessionEnd hook
 * (`.minsky/hooks/guard-events-ingest-on-session-end.ts`, via the
 * `guard-events.ingest` CLI/MCP command) and the cockpit daemon sweeper
 * (`startGuardEventsSweepBackstop`, `src/cockpit/sweepers.ts`) — but they run
 * the SAME function. Per ADR-017 and mt#2313, SessionEnd does not fire (or
 * complete) on `/exit`, `/clear`, or an async kill, so the SessionEnd push is
 * a LATENCY optimization only; the periodic sweep alone must achieve
 * completeness. Every stream's dedupe key makes re-running this function over
 * an already-ingested span a no-op, which is what makes running it from BOTH
 * a fragile per-session hook AND a resilient periodic sweep safe.
 *
 * ## SC2 — dependency failures are LOGGED, never swallowed into "nothing"
 *
 * A per-stream error (a malformed file, a DB error on that stream's batch) is
 * caught, recorded on that stream's result with the ACTUAL error message, and
 * processing continues to the next stream — the summary always reports which
 * streams errored and why; it is never collapsed into a blanket "0 streams
 * had anything to ingest" result. The CALLER (the CLI command and the cockpit
 * sweeper tick) is responsible for logging those errors at `warn`/`error`
 * (kept out of this pure core so tests can assert on the returned summary
 * without needing to fake a logger).
 *
 * @see docs/architecture/guard-calibration-stream-inventory.md — the stream set
 * @see packages/domain/src/storage/schemas/guard-events-schema.ts — the target table
 */
import {
  computeDedupeKey,
  canonicalizeForHash,
  extractPromotedFields,
  resolveTailStart,
  splitCompleteLinesAndOffset,
  parseDisconnectLogArray,
  utf8ByteLength,
} from "./parsing";
import type { GuardEventsHwmEntry, GuardEventsHwmState } from "./hwm-store";
import type { GuardEventStreamSource } from "./stream-sources";

/** Bounds a single tick's per-stream work so a huge backlog (e.g. a fresh-deploy fire-log with no prior ingest) drains over several ticks instead of blocking one indefinitely. Partial progress is safe: the HWM only advances to what was actually processed. */
export const DEFAULT_MAX_RECORDS_PER_STREAM_PER_TICK = 20_000;

export interface GuardEventInsertRow {
  stream: string;
  family: string;
  guardName: string | null;
  sessionId: string | null;
  projectId: string | null;
  occurredAt: Date | null;
  decision: string | null;
  event: string | null;
  durationMs: number | null;
  payload: unknown;
  dedupeKey: string;
  sourcePath: string;
}

export interface GuardEventsStreamResult {
  stream: string;
  /** File did not exist at ingest time — not an error, just nothing to do yet. */
  skippedNoFile: boolean;
  /** New records read and batched for insert this tick (before ON CONFLICT DO NOTHING collapses dupes). */
  read: number;
  /** True when more records remain beyond this tick's `maxRecordsPerStreamPerTick` cap. */
  truncated: boolean;
  error?: string;
}

export interface GuardEventsIngestSummary {
  perStream: GuardEventsStreamResult[];
  totalRead: number;
  totalErrors: number;
}

export interface GuardEventsIngestDeps {
  streams: readonly GuardEventStreamSource[];
  resolvePath: (source: GuardEventStreamSource) => string;
  /** Null if the file does not exist. `size` is the CURRENT total byte size. */
  readTail: (path: string, fromByte: number) => { size: number; content: string } | null;
  /** Whole-file read for the one json-array stream. Null if absent. */
  readWhole: (path: string) => string | null;
  readHwm: () => GuardEventsHwmState;
  writeHwm: (state: GuardEventsHwmState) => void;
  /** Batched insert — ON CONFLICT (dedupe_key) DO NOTHING, no per-row round trips. */
  insertBatch: (rows: GuardEventInsertRow[]) => Promise<void>;
  /** Batch-resolve project ids for a set of distinct session ids (never per-row). */
  resolveProjectIds: (sessionIds: string[]) => Promise<Map<string, string | null>>;
  maxRecordsPerStreamPerTick?: number;
}

function buildRow(
  source: GuardEventStreamSource,
  dedupeKey: string,
  payload: unknown,
  sourcePath: string,
  projectId: string | null
): GuardEventInsertRow {
  const fields = extractPromotedFields(payload, source.guardName);
  return {
    stream: source.stream,
    family: source.family,
    guardName: fields.guardName,
    sessionId: fields.sessionId,
    projectId,
    occurredAt: fields.occurredAt,
    decision: fields.decision,
    event: fields.event,
    durationMs: fields.durationMs,
    payload,
    dedupeKey,
    sourcePath,
  };
}

/**
 * Plan one JSONL stream's new rows + the HWM entry it should advance to,
 * without performing any IO — the caller has already read the tail content.
 * Pure and independently testable.
 */
export function planJsonlStreamRows(
  source: GuardEventStreamSource,
  sourcePath: string,
  tail: { size: number; content: string },
  priorOffset: number | undefined,
  maxRecords: number
): { rows: Array<{ dedupeKey: string; payload: unknown }>; newOffset: number; truncated: boolean } {
  const start = resolveTailStart(tail.size, priorOffset);
  // If we had to reset (rotation/truncation), the caller already re-read from
  // byte 0, so `tail.content` is relative to `start`, not `priorOffset`.
  const { lines, newOffset } = splitCompleteLinesAndOffset(tail.content, start);

  const truncated = lines.length > maxRecords;
  const boundedLines = truncated ? lines.slice(0, maxRecords) : lines;

  const rows: Array<{ dedupeKey: string; payload: unknown }> = [];
  for (const line of boundedLines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // skip malformed line — never blocks the rest of the stream
    }
    rows.push({ dedupeKey: computeDedupeKey(source.stream, line), payload: parsed });
  }

  // When truncated, only advance the offset past the lines we actually
  // consumed — recompute from the bounded slice so a partial tick doesn't
  // skip the remainder next time.
  if (!truncated) return { rows, newOffset, truncated: false };

  const consumedText = `${boundedLines.join("\n")}\n`;
  const consumedBytes = utf8ByteLength(consumedText);
  return { rows, newOffset: start + consumedBytes, truncated: true };
}

/**
 * Plan the one json-array stream's (`mcp-disconnect-log.json`) new rows +
 * the element-count HWM it should advance to. Pure and independently
 * testable.
 */
export function planDisconnectLogRows(
  source: GuardEventStreamSource,
  raw: string,
  priorCount: number | undefined,
  maxRecords: number
): { rows: Array<{ dedupeKey: string; payload: unknown }>; newCount: number; truncated: boolean } {
  const elements = parseDisconnectLogArray(raw);
  const start = priorCount !== undefined && priorCount <= elements.length ? priorCount : 0;
  const pending = elements.slice(start);
  const truncated = pending.length > maxRecords;
  const bounded = truncated ? pending.slice(0, maxRecords) : pending;

  const rows = bounded.map((element) => ({
    dedupeKey: computeDedupeKey(source.stream, canonicalizeForHash(element)),
    payload: element,
  }));

  return { rows, newCount: start + bounded.length, truncated };
}

/**
 * Run one full sweep tick over every registered stream. Never throws — a
 * per-stream failure is captured on that stream's result and the sweep moves
 * on to the next stream (fail-open, matching the transcript sweep's
 * per-session error handling).
 */
export async function runGuardEventsIngestSweep(
  deps: GuardEventsIngestDeps
): Promise<GuardEventsIngestSummary> {
  const maxRecords = deps.maxRecordsPerStreamPerTick ?? DEFAULT_MAX_RECORDS_PER_STREAM_PER_TICK;
  const hwm = deps.readHwm();
  const nextHwm: GuardEventsHwmState = { ...hwm };
  const perStream: GuardEventsStreamResult[] = [];

  for (const source of deps.streams) {
    const path = deps.resolvePath(source);
    try {
      if (source.format === "json-array") {
        const raw = deps.readWhole(path);
        if (raw === null) {
          perStream.push({ stream: source.stream, skippedNoFile: true, read: 0, truncated: false });
          continue;
        }
        const priorCount = hwm[source.stream]?.elementCount;
        const { rows, newCount, truncated } = planDisconnectLogRows(
          source,
          raw,
          priorCount,
          maxRecords
        );
        if (rows.length > 0) {
          const withProjects = await attachProjectIds(rows, path, source, deps.resolveProjectIds);
          await deps.insertBatch(withProjects);
        }
        const entry: GuardEventsHwmEntry = { elementCount: newCount };
        nextHwm[source.stream] = entry;
        perStream.push({
          stream: source.stream,
          skippedNoFile: false,
          read: rows.length,
          truncated,
        });
        continue;
      }

      // jsonl format
      const priorOffset = hwm[source.stream]?.byteOffset;
      const initialTail = deps.readTail(path, priorOffset ?? 0);
      if (initialTail === null) {
        perStream.push({ stream: source.stream, skippedNoFile: true, read: 0, truncated: false });
        continue;
      }
      // Re-read from byte 0 if the persisted offset no longer fits (rotation/truncation).
      const start = resolveTailStart(initialTail.size, priorOffset);
      const tail =
        start === (priorOffset ?? 0) ? initialTail : (deps.readTail(path, start) ?? initialTail);

      const { rows, newOffset, truncated } = planJsonlStreamRows(
        source,
        path,
        tail,
        start,
        maxRecords
      );
      if (rows.length > 0) {
        const withProjects = await attachProjectIds(rows, path, source, deps.resolveProjectIds);
        await deps.insertBatch(withProjects);
      }
      const entry: GuardEventsHwmEntry = { byteOffset: newOffset };
      nextHwm[source.stream] = entry;
      perStream.push({ stream: source.stream, skippedNoFile: false, read: rows.length, truncated });
    } catch (err) {
      // SC2: the actual error, never converted into a silent "nothing to ingest".
      const message = err instanceof Error ? err.message : String(err);
      perStream.push({
        stream: source.stream,
        skippedNoFile: false,
        read: 0,
        truncated: false,
        error: message,
      });
    }
  }

  deps.writeHwm(nextHwm);

  const totalRead = perStream.reduce((sum, s) => sum + s.read, 0);
  const totalErrors = perStream.filter((s) => s.error).length;
  return { perStream, totalRead, totalErrors };
}

async function attachProjectIds(
  rows: Array<{ dedupeKey: string; payload: unknown }>,
  sourcePath: string,
  source: GuardEventStreamSource,
  resolveProjectIds: GuardEventsIngestDeps["resolveProjectIds"]
): Promise<GuardEventInsertRow[]> {
  const built = rows.map((r) => buildRow(source, r.dedupeKey, r.payload, sourcePath, null));
  const sessionIds = [...new Set(built.map((r) => r.sessionId).filter((id): id is string => !!id))];
  if (sessionIds.length === 0) return built;

  const projectIdBySession = await resolveProjectIds(sessionIds);
  return built.map((row) => ({
    ...row,
    projectId: row.sessionId ? (projectIdBySession.get(row.sessionId) ?? null) : null,
  }));
}
