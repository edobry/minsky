/**
 * Pure parsing/hashing primitives for the guard/calibration exhaust ingest
 * (mt#4035, mt#3334 phase 3). No filesystem or DB access anywhere in this
 * file — every function here is a plain value -> value transform so the
 * ingest orchestration (`ingest-service.ts`) can be tested with injected IO
 * deps instead of `spyOn`ing real modules (testable-design).
 *
 * @see packages/domain/src/storage/schemas/guard-events-schema.ts — the dedupe-key contract this implements
 * @see docs/architecture/guard-calibration-stream-inventory.md — the stream vocabulary this parses
 */
import { createHash } from "node:crypto";
import type { GuardEventFamily } from "./stream-sources";

// ---------------------------------------------------------------------------
// Dedupe key (schema doc-comment contract, verbatim)
// ---------------------------------------------------------------------------

/**
 * sha256 hex over `<stream>\n<content>` — the rebuild/idempotency key that
 * backs `uq_guard_events_dedupe_key`'s plain unique index (mem#659: a bare
 * `ON CONFLICT (dedupe_key)` target can only infer a PLAIN unique index, not
 * a partial one).
 *
 * For a JSONL stream, `content` is the verbatim raw line (no trimming of
 * meaningful bytes — only the trailing `\n` the line-splitter already
 * stripped). For the one JSON-array stream (`mcp-disconnect-log.json`),
 * `content` is {@link canonicalizeForHash}'s output for that element — see
 * that function's doc comment for why a canonical form is needed instead of
 * the verbatim slice.
 */
export function computeDedupeKey(stream: string, content: string): string {
  return createHash("sha256").update(`${stream}\n${content}`, "utf-8").digest("hex");
}

// ---------------------------------------------------------------------------
// Canonical element serialization for the one non-JSONL source
// (mcp-disconnect-log.json) — mt#4035 owns this per the schema doc-comment.
// ---------------------------------------------------------------------------

/**
 * Deterministically serialize a parsed JSON value with object keys sorted at
 * every level, recursively. Used ONLY as the dedupe-key hash input for
 * `mcp-disconnect-log.json` elements (see {@link parseDisconnectLogArray}).
 *
 * Why not plain `JSON.stringify`: `disconnect-tracker.ts` writes each event
 * via `JSON.stringify(event)` with an object literal whose key order is
 * fixed by the writer's source today, so plain `JSON.stringify` happens to
 * be stable in practice — but nothing enforces that going forward (a future
 * refactor of the event-construction call site, or a different writer
 * touching the same file, could reorder keys with no functional change to
 * the record). Key order is not semantic content; hashing on it would treat
 * a purely cosmetic writer change as a brand-new event and re-ingest the
 * entire historical corpus as "new" duplicates-that-aren't. Sorting keys
 * before hashing makes the dedupe key a function of CONTENT only, matching
 * every other stream's dedupe key (a function of the verbatim JSONL bytes,
 * which — because JSONL lines are written once and never rewritten — never
 * has this problem to begin with).
 */
export function canonicalizeForHash(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Byte-accurate JSONL tailing
// ---------------------------------------------------------------------------

/**
 * Decide where a JSONL tail-read should start, given the file's current size
 * and the previously-persisted byte offset. Resets to 0 whenever the prior
 * offset no longer fits inside the file — a rotated or truncated file — since
 * a full re-scan from byte 0 is always SAFE via dedupe (constraint #5); the
 * alternative (trusting a now-invalid offset) would silently skip a whole
 * rotation's worth of records.
 */
export function resolveTailStart(fileSize: number, priorOffset: number | undefined): number {
  if (priorOffset === undefined || priorOffset < 0 || priorOffset > fileSize) return 0;
  return priorOffset;
}

/**
 * Split newly-read tail content into complete lines and compute the new byte
 * offset, WITHOUT consuming a trailing partial line (one whose terminating
 * `\n` has not been written yet — the writer's `appendFileSync` call is
 * in-flight, or this tick's read raced an in-progress append). Advancing the
 * offset past a partial line would mean the completed line is never re-read:
 * the bytes already counted as "consumed" can't be re-swept next tick.
 *
 * `fromByte` is the byte offset `content` was read starting at (so the
 * returned `newOffset` is `fromByte + <bytes consumed>`, not `content`-relative).
 */
export function splitCompleteLinesAndOffset(
  chunk: string,
  fromByte: number
): { lines: string[]; newOffset: number } {
  // Cuts here always land on an exact `\n` index (single-UTF-16-unit ASCII),
  // so this can never split a surrogate pair the way a display-truncation
  // cut could — safe without `safeTruncate`.
  const lastNewline = chunk.lastIndexOf("\n");
  if (lastNewline === -1) return { lines: [], newOffset: fromByte };

  const complete = chunk.slice(0, lastNewline);
  const lines = complete.split("\n").filter((line) => line.trim().length > 0);
  const consumedBytes = Buffer.byteLength(chunk.slice(0, lastNewline + 1), "utf-8");
  return { lines, newOffset: fromByte + consumedBytes };
}

// ---------------------------------------------------------------------------
// mcp-disconnect-log.json — hybrid legacy-array + trailing-JSONL parse
// ---------------------------------------------------------------------------

/**
 * Parse `mcp-disconnect-log.json`'s on-disk hybrid format into an ordered
 * array of raw elements. The file predates mt#1682's switch to JSONL
 * appends: a legacy run wrote `JSON.stringify(events, null, 2)` (a single
 * pretty-printed `[...]` array), and every event since has been appended as
 * one flat JSON object per line — so the file today is "legacy array block,
 * then JSONL" (verified in-session against the live file: a leading
 * multi-line `[` block with no matching `]` before the JSONL tail begins).
 *
 * Mirrors `disconnect-tracker.ts`'s own `loadFromDisk` bracket-matching
 * approach rather than the naive line-based skip `disconnect-event-sweep.ts`
 * uses (which silently drops every legacy-block record, since each of its
 * pretty-printed lines fails standalone `JSON.parse`) — this ingest path
 * must not repeat that loss for a corpus this task is explicitly asked to
 * capture in full.
 *
 * Returns raw parsed elements in file order; malformed entries (either format)
 * are skipped, not thrown.
 */
export function parseDisconnectLogArray(raw: string): unknown[] {
  const elements: unknown[] = [];
  let cursor = 0;

  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    const arrayStart = raw.indexOf("[");
    const arrayEnd = findMatchingBracket(raw, arrayStart);
    if (arrayEnd >= 0) {
      const arraySlice = raw.slice(arrayStart, arrayEnd + 1);
      try {
        const parsed: unknown = JSON.parse(arraySlice);
        if (Array.isArray(parsed)) elements.push(...parsed);
      } catch {
        // Corrupted legacy block — fall through to the JSONL tail anyway.
      }
      cursor = arrayEnd + 1;
    }
  }

  const remaining = raw.slice(cursor);
  for (const line of remaining.split("\n")) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith("[") || trimmedLine.startsWith("]")) continue;
    try {
      elements.push(JSON.parse(trimmedLine));
    } catch {
      // skip malformed line
    }
  }

  return elements;
}

/** Bracket-depth matcher respecting string literals — legacy-block-only helper. */
function findMatchingBracket(s: string, start: number): number {
  if (s[start] !== "[") return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Promoted-column extraction (generic, per-record; no per-stream code)
// ---------------------------------------------------------------------------

export interface PromotedFields {
  occurredAt: Date | null;
  sessionId: string | null;
  guardName: string | null;
  decision: string | null;
  event: string | null;
  durationMs: number | null;
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const v = record[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function readNumber(record: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const v = record[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function readTimestamp(record: Record<string, unknown>, ...keys: string[]): Date | null {
  const raw = readString(record, ...keys);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Extract the small promoted-column set from a parsed record. Deliberately
 * generic across every stream family — reads the field-name VARIANTS the
 * inventory's shapes actually use (`sessionId`/`session_id`,
 * `durationMs`/`duration_ms`) rather than branching per stream, so a newly
 * registered stream (constraint #8) needs no code change here either, as
 * long as it uses one of the already-recognized field names. `staticGuardName`
 * (from the stream's registry entry, when set) is used ONLY when the record
 * itself carries no `guardName`/`guard_name` field — a per-record value
 * always wins, matching fire-log/guard-health where one file mixes many
 * guards.
 */
export function extractPromotedFields(
  record: unknown,
  staticGuardName: string | undefined
): PromotedFields {
  if (record === null || typeof record !== "object") {
    return {
      occurredAt: null,
      sessionId: null,
      guardName: staticGuardName ?? null,
      decision: null,
      event: null,
      durationMs: null,
    };
  }
  const r = record as Record<string, unknown>;
  return {
    occurredAt: readTimestamp(r, "timestamp", "observedAt", "firstAt"),
    sessionId: readString(r, "sessionId", "session_id"),
    guardName: readString(r, "guardName", "guard_name") ?? staticGuardName ?? null,
    decision: readString(r, "decision"),
    event: readString(r, "event", "kind"),
    durationMs: readNumber(r, "durationMs", "duration_ms"),
  };
}

export type { GuardEventFamily };
