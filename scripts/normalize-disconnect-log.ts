#!/usr/bin/env bun
/**
 * Convert the MCP disconnect log's legacy JSON-array head to JSONL (mt#4558).
 *
 * ## Why
 *
 * `~/.local/state/minsky/mcp-disconnect-log.json` is two formats in one file: a
 * pretty-printed 65-record array from mt#1645, then ~24,300 JSONL objects from
 * mt#1682 onward. mt#1682 migrated by appending after the old array and leaving
 * both halves; `loadFromDisk` handles that deliberately, so nothing is broken.
 *
 * The cost is that FOUR independent readers each carry a bracket-skip branch —
 * `disconnect-tracker.ts` (loadFromDisk), `disconnect-event-sweep.ts:131`,
 * `s3-gauges.ts:167`, and `measure-escalation-blast-radius.ts:76`. The fourth
 * was written during mt#4481 by an agent reproducing the branch without
 * noticing it was reproducing anything. The hybrid is no longer a one-time
 * migration artifact; it is a shape new code copies.
 *
 * This makes the file uniform so new readers have no wart to copy. It does NOT
 * remove those branches — another machine, a restored backup, or an old state
 * dir can still present a hybrid, and every reader must keep handling it.
 *
 * ## Safety
 *
 * Dry-run by default per `operational-safety-dry-run-first.mdc`; `--execute`
 * writes a timestamped backup first, then replaces the file atomically via
 * temp-write + rename.
 *
 * **Concurrent appends are carried, not raced (reviewer R1).** The daemon
 * appends to this file while this runs. An earlier draft read the tail just
 * before the rename and accepted that an append landing DURING the rename
 * would be lost — and, worse, its verification could not have detected that:
 * the expected line count was derived from the original read, so a dropped
 * append made the counts agree exactly. A probe that returns the same answer
 * whether or not the bug occurred is not verification (mem#704).
 *
 * The fix keeps an fd open on the ORIGINAL inode across the rename. An open
 * descriptor survives the file being replaced, so anything appended to the old
 * inode is still readable afterward and gets folded into the new file.
 * `appendFileSync` reopens by PATH per call, so appends after the rename land
 * in the new file and appends before it are recoverable through the fd —
 * there is no third case. Two independent checks then confirm it: a line-count
 * floor that INCLUDES the carried records, and a content-level multiset
 * comparison against the backup that can fail even when the arithmetic agrees.
 *
 * ## Usage
 *
 *   bun scripts/normalize-disconnect-log.ts              # preview
 *   bun scripts/normalize-disconnect-log.ts --execute    # apply
 *   bun scripts/normalize-disconnect-log.ts --log <path> # non-default file
 *
 * Exit 0 = measured or applied (including the already-uniform no-op).
 * Exit 1 = the file could not be read, or a post-write count check failed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const NEWLINE = String.fromCharCode(10);

function defaultLogPath(): string {
  return path.join(os.homedir(), ".local", "state", "minsky", "mcp-disconnect-log.json");
}

/**
 * Index of the `]` matching the `[` at `start`, tracking string literals so a
 * bracket inside a JSON string does not end the scan early. Mirrors
 * `findMatchingBracket` in `src/mcp/disconnect-tracker.ts` — deliberately
 * duplicated rather than imported, because importing the tracker would pull in
 * its logger, Braintrust emitter and credential scrubber for a one-shot script.
 * Returns -1 when unmatched.
 */
export function findMatchingBracket(source: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export interface NormalizeResult {
  /** True when the file has no leading array — nothing to do. */
  alreadyUniform: boolean;
  /** Records converted out of the legacy array. */
  convertedRecords: number;
  /** Non-blank JSONL lines already present after the array. */
  existingJsonlLines: number;
  /** The rewritten file content, when a conversion applies. */
  content?: string;
}

/**
 * Pure transform: takes the file's text, returns the normalized text plus
 * counts. Separated from all IO so the behaviour is testable without touching
 * a real file (`custom/no-real-fs-in-tests`).
 */
export function normalize(raw: string): NormalizeResult {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("[")) {
    const existing = raw.split(NEWLINE).filter((l) => l.trim() !== "").length;
    return { alreadyUniform: true, convertedRecords: 0, existingJsonlLines: existing };
  }

  const arrayStart = raw.indexOf("[");
  const arrayEnd = findMatchingBracket(raw, arrayStart);
  if (arrayEnd < 0) {
    // An unterminated array is not something to guess at — treat it as
    // already-uniform so `--execute` refuses to rewrite a truncated file.
    return { alreadyUniform: true, convertedRecords: 0, existingJsonlLines: 0 };
  }

  const parsed: unknown = JSON.parse(raw.slice(arrayStart, arrayEnd + 1));
  if (!Array.isArray(parsed)) {
    return { alreadyUniform: true, convertedRecords: 0, existingJsonlLines: 0 };
  }

  const converted = parsed.map((record) => JSON.stringify(record)).join(NEWLINE);
  const remainder = raw.slice(arrayEnd + 1).replace(/^\s+/, "");
  const existing = remainder.split(NEWLINE).filter((l) => l.trim() !== "").length;

  const body =
    remainder.length > 0 ? `${converted}${NEWLINE}${remainder}` : `${converted}${NEWLINE}`;
  const content = body.endsWith(NEWLINE) ? body : `${body}${NEWLINE}`;

  return {
    alreadyUniform: false,
    convertedRecords: parsed.length,
    existingJsonlLines: existing,
    content,
  };
}

/**
 * Multiset of record identities, readable from EITHER format — a hybrid
 * (array + JSONL) or uniform JSONL. Used to compare the backup against the
 * result by CONTENT rather than by line count.
 *
 * Counts rather than a Set because two events can share a millisecond; a Set
 * would silently forgive losing one of a duplicated pair. The key is the whole
 * record, so a change in any field shows up as a missing identity.
 */
export function recordMultiset(raw: string): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (record: unknown) => {
    const key = JSON.stringify(record);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };

  let cursor = 0;
  const trimmed = raw.trimStart();
  if (trimmed.startsWith("[")) {
    const start = raw.indexOf("[");
    const end = findMatchingBracket(raw, start);
    if (end >= 0) {
      try {
        const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
        if (Array.isArray(parsed)) parsed.forEach(bump);
      } catch {
        // intentional-swallow: a corrupt legacy block should not abort the
        // comparison — the JSONL half is still worth checking.
      }
      cursor = end + 1;
    }
  }

  for (const line of raw.slice(cursor).split(NEWLINE)) {
    const t = line.trim();
    if (!t || t.startsWith("[") || t.startsWith("]")) continue;
    try {
      bump(JSON.parse(t));
    } catch {
      // intentional-swallow: unparseable lines are reported by
      // countNonParsingLines; they are not record identities.
    }
  }
  return counts;
}

/**
 * Read a bounded prefix through an open descriptor and report how many bytes
 * were actually consumed (reviewer R2).
 *
 * The offset MUST come from the read itself. Taking it from a separate
 * `statSync` leaves a gap in which an append makes the content longer than the
 * recorded size, and a later drain from that stale offset re-reads bytes the
 * caller already has — duplicating them.
 */
export function readExactPrefix(fd: number): { raw: string; consumed: number } {
  const declared = fs.fstatSync(fd).size;
  const buf = new Uint8Array(declared);
  let consumed = 0;
  while (consumed < declared) {
    const n = fs.readSync(fd, buf, consumed, declared - consumed, consumed);
    if (n <= 0) break;
    consumed += n;
  }
  return { raw: new TextDecoder().decode(buf.subarray(0, consumed)), consumed };
}

/** Everything past `offset` on the descriptor's inode, or "" if nothing. */
export function readFrom(fd: number, offset: number): string {
  const size = fs.fstatSync(fd).size;
  if (size <= offset) return "";
  const buf = new Uint8Array(size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  return new TextDecoder().decode(buf);
}

/**
 * Write `body` to a sibling temp file and rename it over `logPath`.
 *
 * Extracted from `main()` (reviewer R3) so the temp path lives in one short
 * function instead of a `try` nested inside a `try` nested inside `main`. The
 * finding that prompted this — that `tmp` was out of scope in the `catch` — was
 * FALSE (see the PR body for the runtime falsification), but nesting a careful
 * reader misreads is worth flattening even when it is correct.
 *
 * Returns the error rather than throwing, so the caller keeps its own control
 * flow and its own message. Cleans up the temp file on every failure path.
 */
export function writeThenRename(logPath: string, body: string, mode: number): Error | undefined {
  const tmp = `${logPath}.tmp-${process.pid}`;
  try {
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeSync(fd, body.endsWith(NEWLINE) || body === "" ? body : `${body}${NEWLINE}`);
      // Durability before the rename, so a crash cannot leave a renamed-but-
      // empty file where the log used to be (reviewer R1, non-blocking).
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, logPath);
    return undefined;
  } catch (err) {
    // Never leave a stray tmp behind on a failure path (reviewer R1,
    // non-blocking).
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
    return err as Error;
  }
}

/** Non-blank lines that do NOT independently parse as JSON. */
export function countNonParsingLines(raw: string): number {
  let bad = 0;
  for (const line of raw.split(NEWLINE)) {
    if (line.trim() === "") continue;
    try {
      JSON.parse(line);
    } catch {
      bad++;
    }
  }
  return bad;
}

function main(): number {
  const argv = process.argv.slice(1);
  const execute = argv.includes("--execute");
  const logFlag = argv.indexOf("--log");
  const logPath = logFlag >= 0 && argv[logFlag + 1] ? String(argv[logFlag + 1]) : defaultLogPath();

  if (!fs.existsSync(logPath)) {
    console.log(`SKIP: no disconnect log at ${logPath} — nothing to normalize.`);
    return 0;
  }

  // Open ONCE and read a bounded prefix through that descriptor, so the
  // consumed-byte offset is the read's own result rather than a separate stat
  // (reviewer R2 BLOCKING).
  //
  // The earlier shape was `statSync()` for the size, then `readFileSync()` for
  // the content — two syscalls with a gap. An append landing in that gap makes
  // `raw` LONGER than the recorded size, so the later drain re-reads bytes the
  // transform already consumed and DUPLICATES them. The mirror image of the R1
  // defect: same window, opposite damage.
  //
  // Reading exactly `size` bytes through one fd closes it by construction:
  // whatever the read consumed is the offset, and everything past it is
  // unread and therefore drainable exactly once.
  let sizeBefore: number;
  let raw: string;
  let sourceFd: number;
  try {
    sourceFd = fs.openSync(logPath, "r");
  } catch (err) {
    console.error(`FAIL: could not open ${logPath}: ${(err as Error).message}`);
    return 1;
  }
  try {
    const prefix = readExactPrefix(sourceFd);
    raw = prefix.raw;
    sizeBefore = prefix.consumed;
  } catch (err) {
    fs.closeSync(sourceFd);
    console.error(`FAIL: could not read ${logPath}: ${(err as Error).message}`);
    return 1;
  }

  const badBefore = countNonParsingLines(raw);
  const result = normalize(raw);

  console.log(`log:                       ${logPath}`);
  console.log(`bytes:                     ${sizeBefore}`);
  console.log(`non-parsing lines BEFORE:  ${badBefore}`);

  if (result.alreadyUniform) {
    console.log(`legacy array:              none — already uniform JSONL, nothing to do.`);
    console.log(`jsonl lines:               ${result.existingJsonlLines}`);
    fs.closeSync(sourceFd);
    return 0;
  }

  const totalAfter = result.convertedRecords + result.existingJsonlLines;
  console.log(`legacy array records:      ${result.convertedRecords}  (would become JSONL lines)`);
  console.log(`existing jsonl lines:      ${result.existingJsonlLines}`);
  console.log(`total lines after:         ${totalAfter}`);

  if (!execute) {
    console.log("");
    console.log("DRY RUN — nothing written. Re-run with --execute to apply.");
    fs.closeSync(sourceFd);
    return 0;
  }

  const stampedBackup = `${logPath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(logPath, stampedBackup);
  console.log(`backup:                    ${stampedBackup}`);

  // Preserve the original mode so the rewritten file is not silently reopened
  // with the process umask (reviewer R1, non-blocking).
  const originalMode = fs.statSync(logPath).mode;

  // --- The concurrency-safe part (reviewer R1 BLOCKING) -------------------
  //
  // The daemon appends to this file while we run. The naive shape — stat, read
  // the tail, write, rename — leaves a window between the tail read and the
  // rename in which an append lands on the old inode and is lost. Worse, the
  // obvious verification cannot see it: the expected line count is derived
  // from the ORIGINAL read, so a lost append makes the counts match EXACTLY
  // and the check passes. A probe that returns the same answer whether or not
  // the bug occurred is not verification (mem#704).
  //
  // The fix is to keep an fd open on the ORIGINAL inode across the rename.
  // Unlinking a file does not invalidate an open descriptor, so after the
  // rename we can still read anything the daemon appended to the old inode and
  // fold it into the new file. `appendFileSync` reopens by PATH each call, so
  // every append after the rename lands in the new file; every append before
  // it is recoverable through this fd. There is no third case.
  // Reuse the descriptor the prefix was read through — reopening would
  // reintroduce the very gap R2 flagged.
  const originalFd = sourceFd;
  let carried = 0;
  try {
    const drainFrom = (offset: number): string => readFrom(originalFd, offset);

    const preRenameTail = drainFrom(sizeBefore);
    const offsetAfterPreTail = sizeBefore + Buffer.byteLength(preRenameTail, "utf-8");

    const body = `${result.content ?? ""}${preRenameTail.replace(/^\s+/, "")}`;
    const writeError = writeThenRename(logPath, body, originalMode);
    if (writeError) {
      console.error(`FAIL: could not replace ${logPath}: ${writeError.message}`);
      console.error(`The original is untouched. Backup: ${stampedBackup}`);
      return 1;
    }

    // Anything that landed on the OLD inode during the rename is still
    // readable through the fd we held. Fold it into the new file.
    const postRenameTail = drainFrom(offsetAfterPreTail);
    if (postRenameTail.trim() !== "") {
      const normalizedTail = postRenameTail.replace(/^\s+/, "");
      fs.appendFileSync(
        logPath,
        normalizedTail.endsWith(NEWLINE) ? normalizedTail : `${normalizedTail}${NEWLINE}`,
        "utf-8"
      );
      carried = normalizedTail.split(NEWLINE).filter((l) => l.trim() !== "").length;
    }
    const preCarried = preRenameTail.split(NEWLINE).filter((l) => l.trim() !== "").length;
    carried += preCarried;
    if (carried > 0) {
      console.log(`appended while running:    ${carried} record(s) — carried over, none dropped`);
    }
  } finally {
    fs.closeSync(originalFd);
  }

  const after = fs.readFileSync(logPath, "utf-8") as string;
  const badAfter = countNonParsingLines(after);
  const linesAfter = after.split(NEWLINE).filter((l) => l.trim() !== "").length;
  console.log(`non-parsing lines AFTER:   ${badAfter}`);
  console.log(`jsonl lines AFTER:         ${linesAfter}`);

  if (badAfter > 0) {
    console.error(`FAIL: ${badAfter} lines still do not parse. Restore from ${stampedBackup}.`);
    return 1;
  }

  // The expected floor INCLUDES everything the drain carried over. Deriving it
  // from the original read alone was the R1 BLOCKING defect: a dropped append
  // would make the counts agree exactly, so the check could not fail for the
  // case it existed to catch.
  const expectedFloor = totalAfter + carried;
  if (linesAfter < expectedFloor) {
    console.error(
      `FAIL: expected at least ${expectedFloor} lines (${totalAfter} converted + ${carried} carried), found ${linesAfter}. Restore from ${stampedBackup}.`
    );
    return 1;
  }

  // Independent of the count: the backup holds every record that existed when
  // we started, so nothing in it may be missing from the result. This catches a
  // loss the arithmetic cannot, because it compares CONTENT rather than totals.
  const backupRecords = recordMultiset(fs.readFileSync(stampedBackup, "utf-8") as string);
  const afterRecords = recordMultiset(after);
  let backupTotal = 0;
  let deficit = 0;
  let firstMissing = "";
  for (const [key, count] of backupRecords) {
    backupTotal += count;
    const found = afterRecords.get(key) ?? 0;
    if (found < count) {
      deficit += count - found;
      if (firstMissing === "") firstMissing = key.slice(0, 120);
    }
  }
  if (deficit > 0) {
    console.error(
      `FAIL: ${deficit} record(s) in the backup are absent from the result (e.g. ${firstMissing}). Restore from ${stampedBackup}.`
    );
    return 1;
  }

  console.log(`records cross-checked:     ${backupTotal} from backup, all present`);
  console.log("OK: file is uniform JSONL and no records were lost.");
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
