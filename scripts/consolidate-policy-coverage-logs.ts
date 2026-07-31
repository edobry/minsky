#!/usr/bin/env bun
/**
 * One-time consolidation of stray `policy-coverage` calibration logs — mt#3393.
 *
 * Before mt#3393 the policy-coverage detector resolved its calibration log path
 * from `input.cwd`, so records written by a dispatched subagent landed under
 * that agent's session workspace instead of the repo. 22 such logs accumulated
 * under `<state-dir>/sessions/<id>/.minsky/`, invisible to
 * `scripts/check-coverage-receipts.ts` (which reads the repo's `.minsky/` and
 * nothing else) and gitignored, so a session cleanup destroyed them.
 *
 * This script merges those records back into the repo's log. It is dry-run by
 * default; `--execute` performs the write.
 *
 * On `--execute` the merged log is written back SORTED BY TIMESTAMP. The
 * pre-existing repo log is not chronologically ordered — a prior consolidation
 * appended an out-of-order block to the end — and reading its tail is what
 * produced mt#3393's original (false) problem statement, "no record since
 * 2026-05-31", when records ran through 2026-07-16. Sorting removes that trap.
 * The original file is copied to `<log>.bak` first.
 *
 * Records are de-duplicated by exact line content, so re-running is idempotent
 * and stray source logs are left in place rather than deleted.
 *
 * Usage:
 *   bun scripts/consolidate-policy-coverage-logs.ts             # dry run
 *   bun scripts/consolidate-policy-coverage-logs.ts --execute   # apply
 *   bun scripts/consolidate-policy-coverage-logs.ts --limit 1   # bound the scan
 *
 * @see .minsky/hooks/types.ts — deriveHookRepoRoot, the fix this cleans up after
 * @see scripts/check-coverage-receipts.ts — the consumer that could not see these
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const { deriveHookRepoRoot } = await import("../.minsky/hooks/types");

const LOG_FILENAME = "policy-coverage-calibration.jsonl";

/**
 * Resolve `<state-dir>/sessions`, mirroring
 * `require-session-for-main-workspace-edits.ts`'s `deriveSessionWorkspaceRoot`
 * (mt#2928): the `MINSKY_STATE_DIR` override first, else XDG.
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

/** Every `<sessions-root>/<id>/.minsky/<LOG_FILENAME>` that exists on disk. */
function discoverStrayLogs(sessionsRoot: string, limit?: number): StrayLog[] {
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
    const path = join(sessionsRoot, name, ".minsky", LOG_FILENAME);
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
function timestampOf(line: string): string {
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

function parseArgs(argv: string[]): { execute: boolean; limit?: number } {
  const execute = argv.includes("--execute");
  let limit: number | undefined;
  const idx = argv.indexOf("--limit");
  if (idx !== -1) {
    const v = Number(argv[idx + 1]);
    if (Number.isFinite(v) && v > 0) limit = Math.floor(v);
  }
  return { execute, limit };
}

async function main(): Promise<void> {
  const { execute, limit } = parseArgs(process.argv.slice(2));
  // Same discipline the fix itself enforces: resolve the repo from the
  // installation, not from wherever the operator's shell happens to be. Run
  // from a session workspace, a `process.cwd()` derivation would consolidate
  // the stray records INTO that session's log — reproducing the very defect
  // this script exists to clean up.
  const repoRoot = deriveHookRepoRoot();
  const mainLog = join(repoRoot, ".minsky", LOG_FILENAME);
  const sessionsRoot = deriveSessionWorkspaceRoot();

  const existing = existsSync(mainLog) ? readLines(mainLog) : [];
  const seen = new Set(existing);
  console.log(`Repo log:      ${mainLog}`);
  console.log(`  existing records: ${existing.length}`);
  console.log(`Scanning:      ${sessionsRoot}${limit !== undefined ? ` (limit ${limit})` : ""}`);

  const strays = discoverStrayLogs(sessionsRoot, limit);
  const additions: string[] = [];
  for (const stray of strays) {
    const fresh = stray.lines.filter((l) => !seen.has(l));
    for (const l of fresh) seen.add(l);
    additions.push(...fresh);
    console.log(`  ${stray.lines.length} records (${fresh.length} new)  ${stray.path}`);
  }

  console.log("");
  console.log(`Stray logs found:  ${strays.length}`);
  console.log(`New records:       ${additions.length}`);
  console.log(`Merged total:      ${existing.length + additions.length}`);

  if (!execute) {
    console.log("");
    console.log("DRY RUN — no files written. Re-run with --execute to apply.");
    return;
  }

  const merged = [...existing, ...additions].sort((a, b) =>
    timestampOf(a).localeCompare(timestampOf(b))
  );

  if (existsSync(mainLog)) {
    copyFileSync(mainLog, `${mainLog}.bak`);
    console.log(`Backup written:    ${mainLog}.bak`);
  }
  writeFileSync(mainLog, merged.length > 0 ? `${merged.join("\n")}\n` : "", "utf-8");
  console.log(`Wrote:             ${mainLog} (${merged.length} records, sorted by timestamp)`);
  console.log("Stray source logs left in place — de-duplication makes re-runs idempotent.");
}

await main();
