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
 * **Race bound, stated rather than papered over:** the daemon appends to this
 * file with `O_APPEND` while this runs. Appends landing between the read and
 * the rename are captured (the tail beyond the original size is re-read
 * immediately before writing), but an append racing the rename itself targets
 * the old inode and is lost. The window is sub-millisecond and the data is
 * observability, so this is accepted rather than solved — the backup and the
 * count check below are what make it recoverable. Prefer running it when the
 * daemon is idle.
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

  let sizeBefore: number;
  let raw: string;
  try {
    sizeBefore = fs.statSync(logPath).size;
    raw = fs.readFileSync(logPath, "utf-8") as string;
  } catch (err) {
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
    return 0;
  }

  const totalAfter = result.convertedRecords + result.existingJsonlLines;
  console.log(`legacy array records:      ${result.convertedRecords}  (would become JSONL lines)`);
  console.log(`existing jsonl lines:      ${result.existingJsonlLines}`);
  console.log(`total lines after:         ${totalAfter}`);

  if (!execute) {
    console.log("");
    console.log("DRY RUN — nothing written. Re-run with --execute to apply.");
    return 0;
  }

  const backup = `${logPath}.backup-${sizeBefore}`;
  fs.copyFileSync(logPath, backup);
  console.log(`backup:                    ${backup}`);

  // Capture anything appended while we were working, so a concurrent write is
  // carried into the new file rather than dropped.
  let tail = "";
  const sizeNow = fs.statSync(logPath).size;
  if (sizeNow > sizeBefore) {
    const fd = fs.openSync(logPath, "r");
    try {
      const buf = new Uint8Array(sizeNow - sizeBefore);
      fs.readSync(fd, buf, 0, buf.length, sizeBefore);
      tail = new TextDecoder().decode(buf);
      console.log(`appended while running:    ${buf.length} bytes — carried over`);
    } finally {
      fs.closeSync(fd);
    }
  }

  const finalContent =
    tail.length > 0 ? `${result.content}${tail.replace(/^\s+/, "")}` : result.content;
  const tmp = `${logPath}.tmp-${sizeBefore}`;
  fs.writeFileSync(tmp, finalContent ?? "", "utf-8");
  fs.renameSync(tmp, logPath);

  const after = fs.readFileSync(logPath, "utf-8") as string;
  const badAfter = countNonParsingLines(after);
  const linesAfter = after.split(NEWLINE).filter((l) => l.trim() !== "").length;
  console.log(`non-parsing lines AFTER:   ${badAfter}`);
  console.log(`jsonl lines AFTER:         ${linesAfter}`);

  if (badAfter > 0) {
    console.error(`FAIL: ${badAfter} lines still do not parse. Restore from ${backup}.`);
    return 1;
  }
  if (linesAfter < totalAfter) {
    console.error(
      `FAIL: expected at least ${totalAfter} lines, found ${linesAfter}. Restore from ${backup}.`
    );
    return 1;
  }
  console.log("OK: file is uniform JSONL and no records were lost.");
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
