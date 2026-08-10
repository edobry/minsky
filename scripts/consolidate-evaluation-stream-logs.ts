#!/usr/bin/env bun
/**
 * Consolidate stray evaluation-stream logs back into the repo (mt#3745).
 *
 * Two of the three evaluation-stream writers resolved their root from the
 * guard's raw `input.cwd` instead of preferring `CLAUDE_PROJECT_DIR`, so every
 * hook invocation whose cwd was a session workspace wrote its record THERE
 * while the calibration log — routed through the dispatcher's
 * `calibrationLogPath` — landed correctly in the repo. The result is a repo
 * stream that silently undercounts, which matters because ADR-024 §(b)'s
 * sufficiency bar is measured over these records.
 *
 * This script merges the stray records back. It is dry-run by default;
 * `--execute` performs the write.
 *
 * On `--execute`, per stream: the merged log is written back SORTED BY
 * TIMESTAMP, the original is copied to `<log>.bak` first, and the stray files
 * are removed so the next run finds nothing (idempotent). Records already
 * present in the repo log are not duplicated — dedupe is by exact line, which
 * is safe here because each record carries a distinct timestamp.
 *
 * Usage:
 *   bun scripts/consolidate-evaluation-stream-logs.ts             # dry run
 *   bun scripts/consolidate-evaluation-stream-logs.ts --execute   # apply
 *   bun scripts/consolidate-evaluation-stream-logs.ts --limit 1   # bound the scan
 *
 * @see .minsky/hooks/dispatcher.ts — evaluationLogPath, the fix this cleans up after
 * @see scripts/consolidate-policy-coverage-logs.ts — the mt#3393 precedent this mirrors
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const { deriveHookRepoRoot } = await import("../.minsky/hooks/types");

/**
 * The streams that exist today. A stream missing from disk is reported and
 * skipped rather than treated as an error — a detector that has never fired in
 * this checkout legitimately has no log.
 */
const STREAM_NAMES = [
  "retrospective-trigger",
  "silent-stretch",
  "stop-at-decision",
  // mt#3782: the fourth writer. mt#3745 enumerated the streams by listing
  // `.minsky/*-evaluations.jsonl` in the repo and got three — enumeration
  // against the artifact a cwd-rooting writer prevents from existing. The
  // authoritative enumeration greps the hook sources for the write call.
  "operator-deferral",
] as const;

function logFilename(streamName: string): string {
  return `${streamName}-evaluations.jsonl`;
}

/**
 * Resolve `<state-dir>/sessions`, mirroring the policy-coverage consolidator's
 * `deriveSessionWorkspaceRoot` (mt#2928): the `MINSKY_STATE_DIR` override
 * first, else XDG.
 */
function deriveSessionWorkspaceRoot(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = env.MINSKY_STATE_DIR
    ? env.MINSKY_STATE_DIR
    : join(env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"), "minsky");
  return join(stateDir, "sessions");
}

interface StrayLog {
  path: string;
  lines: string[];
}

/** Every `<sessions-root>/<id>/.minsky/<log>` that exists on disk, for one stream. */
export function discoverStrayLogs(
  sessionsRoot: string,
  streamName: string,
  limit?: number
): StrayLog[] {
  let names: string[];
  try {
    names = readdirSync(sessionsRoot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`No session-workspace root to scan (${sessionsRoot}): ${msg}`);
    return [];
  }

  const found: StrayLog[] = [];
  for (const name of names.sort()) {
    if (limit !== undefined && found.length >= limit) break;
    const path = join(sessionsRoot, name, ".minsky", logFilename(streamName));
    if (!existsSync(path)) continue;
    found.push({ path, lines: readLines(path) });
  }
  return found;
}

function readLines(path: string): string[] {
  try {
    return readFileSync(path, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ! unreadable (${msg}) — skipped: ${path}`);
    return [];
  }
}

/** Parse a record's timestamp for sorting; unparseable records sort first. */
export function timestampOf(line: string): string {
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed && typeof parsed === "object" && "timestamp" in parsed) {
      const t = (parsed as { timestamp: unknown }).timestamp;
      if (typeof t === "string") return t;
    }
  } catch {
    // Unparseable line — keep it (the log is append-only evidence, not a
    // schema-validated store) and let it sort to the front.
  }
  return "";
}

/**
 * Merge stray lines into the existing ones: dedupe by exact line, sort by
 * timestamp. Pure, so the merge is testable without touching the filesystem.
 */
export function mergeStreamLines(existing: string[], strayLines: string[]): string[] {
  const seen = new Set(existing);
  const additions = strayLines.filter((l) => !seen.has(l));
  return [...existing, ...additions].sort((a, b) => timestampOf(a).localeCompare(timestampOf(b)));
}

export function parseArgs(argv: string[]): { execute: boolean; limit?: number } {
  const execute = argv.includes("--execute");
  let limit: number | undefined;
  const idx = argv.indexOf("--limit");
  if (idx !== -1) {
    const v = Number(argv[idx + 1]);
    if (Number.isFinite(v) && v > 0) limit = Math.floor(v);
  }
  return { execute, limit };
}

/** One stream's before/after accounting, returned so callers can assert on it. */
export interface StreamResult {
  streamName: string;
  repoRecords: number;
  strayFiles: number;
  recovered: number;
  afterMerge: number;
  strayPaths: string[];
}

/**
 * The consolidation itself, with its roots INJECTED rather than derived.
 *
 * Split out from `main()` so the `--execute` path — backup, merged write, stray
 * removal, idempotency — is testable end-to-end against fixture directories
 * instead of only through the process's own repo. `main()` is the imperative
 * shell that resolves the roots and prints; this is the part with the behavior.
 */
export function consolidateStreams(options: {
  repoRoot: string;
  sessionsRoot: string;
  execute: boolean;
  limit?: number;
  log?: (line: string) => void;
}): StreamResult[] {
  const { repoRoot, sessionsRoot, execute, limit } = options;
  const log = options.log ?? (() => undefined);
  const results: StreamResult[] = [];

  for (const streamName of STREAM_NAMES) {
    const mainLog = join(repoRoot, ".minsky", logFilename(streamName));
    const existing = existsSync(mainLog) ? readLines(mainLog) : [];
    const strays = discoverStrayLogs(sessionsRoot, streamName, limit);

    const merged = mergeStreamLines(
      existing,
      strays.flatMap((s) => s.lines)
    );
    const result: StreamResult = {
      streamName,
      repoRecords: existing.length,
      strayFiles: strays.length,
      recovered: merged.length - existing.length,
      afterMerge: merged.length,
      strayPaths: strays.map((s) => s.path),
    };
    results.push(result);

    log(`[${streamName}]`);
    log(`  repo records:    ${result.repoRecords}`);
    log(`  stray files:     ${result.strayFiles}`);
    log(`  recovered:       ${result.recovered}`);
    log(`  after merge:     ${result.afterMerge}`);
    for (const s of strays) log(`    - ${s.path} (${s.lines.length})`);

    if (!execute || strays.length === 0) continue;

    if (existsSync(mainLog)) {
      copyFileSync(mainLog, `${mainLog}.bak`);
      log(`  backup:          ${mainLog}.bak`);
    }
    mkdirSync(dirname(mainLog), { recursive: true });
    writeFileSync(mainLog, merged.length > 0 ? `${merged.join("\n")}\n` : "", "utf-8");
    log(`  wrote:           ${mainLog} (sorted by timestamp)`);
    for (const s of strays) {
      rmSync(s.path, { force: true });
      log(`  removed stray:   ${s.path}`);
    }
  }

  return results;
}

async function main(): Promise<void> {
  const { execute, limit } = parseArgs(process.argv.slice(2));
  const repoRoot = deriveHookRepoRoot();
  const sessionsRoot = deriveSessionWorkspaceRoot();

  console.log(`Repo root:         ${repoRoot}`);
  console.log(`Sessions root:     ${sessionsRoot}`);
  console.log(`Mode:              ${execute ? "EXECUTE" : "dry run"}`);
  console.log("");

  // `deriveHookRepoRoot()` resolves from THIS FILE's location, so running the
  // script out of a session workspace would consolidate the operator's records
  // INTO that workspace — which is deleted at merge, destroying exactly the
  // records this script exists to recover. Dry-run there is harmless and
  // useful; `--execute` is refused.
  if (repoRoot.startsWith(sessionsRoot)) {
    console.error("");
    console.error(`REFUSED: this script resolved its repo root to a SESSION workspace.`);
    console.error(`  ${repoRoot}`);
    console.error(
      "Consolidating there would move records into a workspace that is deleted at merge."
    );
    console.error("Run it from the MAIN checkout instead.");
    if (execute) process.exit(1);
    console.error("(Continuing the dry run for inspection only.)");
    console.error("");
  }

  const results = consolidateStreams({
    repoRoot,
    sessionsRoot,
    execute,
    limit,
    log: (line) => console.log(line),
  });

  const totalStrayFiles = results.reduce((n, r) => n + r.strayFiles, 0);
  const totalRecovered = results.reduce((n, r) => n + r.recovered, 0);

  console.log("");
  console.log(`Total stray files: ${totalStrayFiles}`);
  console.log(`Total recovered:   ${totalRecovered}`);
  if (!execute) {
    console.log("DRY RUN — no files written. Re-run with --execute to apply.");
  }
}

if (import.meta.main) {
  await main();
}
