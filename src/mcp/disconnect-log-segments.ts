/**
 * Monthly segmentation for the MCP disconnect log (mt#4495).
 *
 * ## Why this module exists, and why it imports almost nothing
 *
 * FOUR independent readers consume this log — `disconnect-tracker.ts`'s
 * `loadFromDisk`, `disconnect-event-sweep.ts`, the cockpit's `s3-gauges.ts`
 * widget, and `scripts/measure-escalation-blast-radius.ts`. Each one reads the
 * whole file today and differs only in how much history it wants. Segmenting
 * the corpus without a shared definition would mean four independent notions of
 * "where the log lives", and the first roll would silently narrow whichever one
 * was missed.
 *
 * So the segment layout is defined once, here. This module deliberately imports
 * only `node:fs` and `node:path` — the same constraint `disconnect-escalation.ts`
 * (mt#4499) was created under, and for the same reason: `s3-gauges.ts` must be
 * able to import it without dragging in the tracker's logger, Braintrust emitter
 * and credential scrubber. Every filesystem touch is behind an injectable seam
 * so tests do not need a real tmpdir (`custom/no-real-fs-in-tests`).
 *
 * ## The layout
 *
 *   mcp-disconnect-log.json           <- ACTIVE. Name and path unchanged, so
 *                                        every existing reader and every recipe
 *                                        in `mcp-disconnect-cadence.mdc` keeps
 *                                        working for the recent window.
 *   mcp-disconnect-log-2026-07.json   <- rolled segment, one per calendar month
 *   mcp-disconnect-log-2026-08.json
 *
 * Segments are named by MONTH rather than by a rotation ordinal because the
 * consumer that drives the retention decision (mt#4487) reads cadence per regime
 * ACROSS months. `-2026-07` is directly selectable by that query; a winston-style
 * `.3` suffix is not, and its ordinal changes meaning every time a file rolls.
 *
 * ## What this module does NOT do
 *
 * It never deletes. mt#4495's retention decision is "keep every segment forever",
 * grounded in a measurement: the `system_events` projection of this log holds 48%
 * of the records, is missing 57 days entirely, and carries `kind` on zero rows —
 * so the file is the only complete copy, and a deleted segment is unrecoverable.
 * The size valve below bounds a single SEGMENT, never the corpus.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Size at which the active file rolls even mid-month.
 *
 * Grounded twice. It matches the in-tree precedent — `DAEMON_LOG_MAX_BYTES` in
 * `src/cockpit/daemon-file-log.ts` — and at this log's measured growth rate
 * (~40 KB/day, busiest day ever 258 KB) it is roughly ten months of typical
 * traffic. So in normal operation the calendar trigger always fires first and
 * this never does. It is a valve against a crash-loop pathology, not a policy.
 */
export const SEGMENT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * How much of a segment's tail to read when filling the in-memory ring.
 *
 * `MAX_EVENTS` is 500 and the measured mean record is 175 bytes, so 500 records
 * is ~88 KB. 256 KB holds ~1,460 records at that rate — comfortable headroom
 * over the ring size without reading a corpus-sized amount.
 */
export const TAIL_READ_BYTES = 256 * 1024;

/**
 * How many same-month segments to tolerate before refusing to roll.
 *
 * A second segment for one month is already unusual — it needs a file already
 * sitting at the primary name. A hundred means something is wrong that rotation
 * should not paper over, so the roll refuses and the log keeps growing visibly
 * rather than silently spraying files.
 */
export const MAX_SEGMENT_ORDINAL = 100;

/** `2026-08-25T16:51:09.669Z` -> `2026-08`. Empty string if unparseable. */
export function monthOf(timestamp: string): string {
  if (typeof timestamp !== "string" || timestamp.length < 7) return "";
  const month = timestamp.slice(0, 7);
  return /^\d{4}-\d{2}$/.test(month) ? month : "";
}

/**
 * Month of the NEWEST parseable record in a chunk of log text, or "".
 *
 * Scans from the END so a corpus-sized string is not fully parsed to answer a
 * question about its last line. Tolerates the legacy hybrid's `]` residue and
 * a truncated leading record, both of which a tail read can produce.
 */
export function newestTimestampMonth(raw: string): string {
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").trim();
    if (!line || line.startsWith("[") || line.startsWith("]")) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      const ts = (parsed as { timestamp?: unknown })?.timestamp;
      if (typeof ts === "string") {
        const month = monthOf(ts);
        if (month !== "") return month;
      }
    } catch {
      // intentional-swallow: a partial or malformed line is expected at the
      // head of a tail read and at the tail of a live log. Keep scanning.
    }
  }
  return "";
}

/** `/x/mcp-disconnect-log.json` + `2026-07` -> `/x/mcp-disconnect-log-2026-07.json`. */
export function segmentPathFor(activePath: string, month: string): string {
  const dir = path.dirname(activePath);
  const ext = path.extname(activePath);
  const base = path.basename(activePath, ext);
  return path.join(dir, `${base}-${month}${ext}`);
}

/** The month a segment filename encodes, or "" if it is not a segment name. */
export function monthOfSegmentPath(activePath: string, candidate: string): string {
  const ext = path.extname(activePath);
  const base = path.basename(activePath, ext);
  const name = path.basename(candidate);
  const match = new RegExp(
    `^${escapeForRegExp(base)}-(\\d{4}-\\d{2})(?:-\\d+)?${escapeForRegExp(ext)}$`
  ).exec(name);
  return match?.[1] ?? "";
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The narrow seam segment ENUMERATION needs.
 *
 * Split out from `SegmentFsDeps` so the other three readers of this log can
 * satisfy it with the injectable filesystem they already carry, instead of
 * growing a full read/rename surface they have no use for. `SegmentFsDeps`
 * structurally satisfies this, so a caller holding one can pass it directly.
 */
export interface SegmentListDeps {
  existsSync: (p: string) => boolean;
  readdirSync: (p: string) => string[];
}

/** Filesystem seam. Production wraps `node:fs`; tests pass an in-memory fake. */
export interface SegmentFsDeps extends SegmentListDeps {
  statSync: (p: string) => { size: number };
  renameSync: (from: string, to: string) => void;
  openSync: (p: string, flags: string) => number;
  readSync: (
    fd: number,
    buf: Uint8Array,
    offset: number,
    length: number,
    position: number
  ) => number;
  closeSync: (fd: number) => void;
}

export const defaultSegmentFsDeps: SegmentFsDeps = {
  existsSync: (p) => fs.existsSync(p),
  statSync: (p) => fs.statSync(p),
  readdirSync: (p) => fs.readdirSync(p),
  renameSync: (from, to) => fs.renameSync(from, to),
  openSync: (p, flags) => fs.openSync(p, flags),
  readSync: (fd, buf, offset, length, position) => fs.readSync(fd, buf, offset, length, position),
  closeSync: (fd) => fs.closeSync(fd),
};

export interface RollDecision {
  roll: boolean;
  /** Month the rolled segment should be named for. "" when not rolling. */
  month: string;
  reason: "calendar" | "size" | "none";
}

/**
 * Pure decision: should the active file roll, and under what name?
 *
 * Separated from all IO so the interesting behaviour is testable without a
 * tmpdir — the same split `scripts/normalize-disconnect-log.ts` uses.
 *
 * `newestRecordMonth` is the month of the LAST record in the active file, not
 * the file's mtime. mtime moves when anything touches the file; the record's own
 * timestamp is what decides which month its data belongs to.
 */
export function decideRoll(input: {
  activeSize: number;
  newestRecordMonth: string;
  currentMonth: string;
  maxBytes?: number;
}): RollDecision {
  const maxBytes = input.maxBytes ?? SEGMENT_MAX_BYTES;

  // An empty or unreadable active file has nothing to preserve.
  if (input.activeSize <= 0) return { roll: false, month: "", reason: "none" };

  // Calendar trigger: the newest record predates the current month.
  if (
    input.newestRecordMonth !== "" &&
    input.currentMonth !== "" &&
    input.newestRecordMonth < input.currentMonth
  ) {
    return { roll: true, month: input.newestRecordMonth, reason: "calendar" };
  }

  // Size valve. Names the segment for the newest record's month so the file is
  // still self-describing; falls back to the current month when the log carries
  // no parseable timestamp.
  if (input.activeSize >= maxBytes) {
    const month = input.newestRecordMonth !== "" ? input.newestRecordMonth : input.currentMonth;
    return { roll: true, month, reason: "size" };
  }

  return { roll: false, month: "", reason: "none" };
}

/**
 * Every rolled segment beside `activePath`, oldest first.
 *
 * `sinceMonth` bounds the scan for callers that only need recent history (the
 * sweep, keyed to its high-water mark). Omit it to get the whole corpus.
 *
 * Returns [] rather than throwing when the directory cannot be read: a reader
 * that cannot enumerate segments should still serve the active file rather than
 * fail closed on a census.
 */
export function listSegmentPaths(
  activePath: string,
  deps: SegmentListDeps = defaultSegmentFsDeps,
  sinceMonth?: string
): string[] {
  let entries: string[];
  try {
    entries = deps.readdirSync(path.dirname(activePath));
  } catch {
    // intentional-swallow: an unreadable state dir means "no segments visible",
    // which the caller already handles. Throwing here would turn a partial
    // census into no census.
    return [];
  }

  const dir = path.dirname(activePath);
  return entries
    .map((name) => ({ name, month: monthOfSegmentPath(activePath, name) }))
    .filter((e) => e.month !== "")
    .filter((e) => (sinceMonth ? e.month >= sinceMonth : true))
    .sort((a, b) =>
      a.month < b.month
        ? -1
        : a.month > b.month
          ? 1
          : a.name < b.name
            ? -1
            : a.name > b.name
              ? 1
              : 0
    )
    .map((e) => path.join(dir, e.name));
}

/**
 * The whole log corpus in chronological order: rolled segments oldest-first,
 * then the active file. This is what a reader wanting "all history" should use.
 */
export function listCorpusPaths(
  activePath: string,
  deps: SegmentListDeps = defaultSegmentFsDeps,
  sinceMonth?: string
): string[] {
  const segments = listSegmentPaths(activePath, deps, sinceMonth);
  return deps.existsSync(activePath) ? [...segments, activePath] : segments;
}

/**
 * Read at most `maxBytes` from the END of a file.
 *
 * When the file is larger than the window the first line is almost certainly a
 * partial record, so it is dropped — that is what `droppedPartialHead` reports.
 * A caller filling a bounded ring does not care; a caller doing a census must
 * not use this at all.
 *
 * The offset comes from the same descriptor the content is read through, so a
 * concurrent append cannot make the two disagree (the shape reviewed into
 * `scripts/normalize-disconnect-log.ts` under mt#4558 R2).
 */
export function readTail(
  filePath: string,
  maxBytes: number = TAIL_READ_BYTES,
  deps: SegmentFsDeps = defaultSegmentFsDeps
): { raw: string; bytesRead: number; droppedPartialHead: boolean } {
  const empty = { raw: "", bytesRead: 0, droppedPartialHead: false };
  if (!deps.existsSync(filePath)) return empty;

  let fd: number | undefined;
  try {
    const size = deps.statSync(filePath).size;
    if (size <= 0) return empty;

    const window = Math.min(size, maxBytes);
    const position = size - window;
    fd = deps.openSync(filePath, "r");

    const buf = new Uint8Array(window);
    let filled = 0;
    while (filled < window) {
      const n = deps.readSync(fd, buf, filled, window - filled, position + filled);
      if (n <= 0) break;
      filled += n;
    }

    const raw = new TextDecoder().decode(buf.subarray(0, filled));
    // Only a windowed read can begin mid-record. A full-file read cannot.
    const truncated = position > 0;
    if (!truncated) return { raw, bytesRead: filled, droppedPartialHead: false };

    const firstNewline = raw.indexOf("\n");
    if (firstNewline < 0) {
      // The window landed entirely inside one record — nothing usable.
      return { raw: "", bytesRead: filled, droppedPartialHead: true };
    }
    return { raw: raw.slice(firstNewline + 1), bytesRead: filled, droppedPartialHead: true };
  } catch {
    // intentional-swallow: a tail read is best-effort. A reader that cannot
    // read the tail should start with an empty ring, not crash the process it
    // is initializing.
    return empty;
  } finally {
    if (fd !== undefined) {
      try {
        deps.closeSync(fd);
      } catch {
        // intentional-swallow: close failure on a read-only fd has no recovery
        // and must not mask the read's result.
      }
    }
  }
}

/**
 * Roll `activePath` to its monthly segment if the decision says so.
 *
 * The roll is a single `rename`, which is atomic and cannot interleave with an
 * `appendFileSync` — that is why this is safe to do while the daemon may be
 * writing, and why the write path itself is left completely untouched
 * (mt#4495 SC5).
 *
 * If a segment for that month already exists — two processes booting in the
 * same window, or a manual roll — this does NOT overwrite it. Overwriting would
 * delete history, which the retention decision forbids outright.
 *
 * Returns the segment path on a completed roll, `null` otherwise.
 */
export function rollIfNeeded(
  activePath: string,
  decision: RollDecision,
  deps: SegmentFsDeps = defaultSegmentFsDeps
): string | null {
  if (!decision.roll || decision.month === "") return null;

  try {
    // Find a free name. When the primary `-YYYY-MM` is taken we neither
    // OVERWRITE (that deletes history, which the retention decision forbids) nor
    // REFUSE (reviewer R1, PR #3368).
    //
    // Why refusing is wrong, stated as precisely as the reproduction supports:
    // refusing leaves the prior month's records IN THE ACTIVE FILE. Two harms
    // follow. The active file is then never bounded for that month, which is the
    // growth fix defeated in the one case it was needed. And if the existing
    // segment's content OVERLAPS the active file's — a restored backup, an
    // operator copy, a roll interrupted between copy and unlink — every
    // overlapping record is then counted twice by `listCorpusPaths`, which was
    // reproduced before this fix: one record appeared TWICE across the corpus.
    //
    // Rolling to `-YYYY-MM-2`, `-3`, ... gives every record exactly one home and
    // deletes nothing. Note the bound: this stops rotation from CREATING or
    // PERPETUATING a duplicate. A duplicate already sitting on disk when we
    // arrive is not something rotation can repair, because the only repair is
    // deletion.
    let target = segmentPathFor(activePath, decision.month);
    for (let n = 2; deps.existsSync(target) && n <= MAX_SEGMENT_ORDINAL; n++) {
      target = segmentPathFor(activePath, `${decision.month}-${n}`);
    }
    // Ordinals exhausted — refuse rather than overwrite. Duplication is bad;
    // deletion is worse, and this needs a human either way.
    if (deps.existsSync(target)) return null;
    deps.renameSync(activePath, target);
    return target;
  } catch {
    // intentional-swallow: a failed roll leaves the active file exactly as it
    // was. The log keeps growing, which is the pre-mt#4495 status quo — strictly
    // better than failing the boot of the process doing the roll.
    return null;
  }
}
