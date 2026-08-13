// Producer/consumer record of "did the PR merged for <task> touch a deploy/build
// surface?" (mt#3819).
//
// Why this exists. `build-claim-injection-detector` needs that fact to evaluate
// its condition (a). It cannot ask the forge: it runs on EVERY `UserPromptSubmit`
// under `deriveBudgets(hostCapSec)`, and a network round-trip per turn is the bar
// `inject-prod-state.ts` documents refusing ("A per-turn query against the prod DB
// is a network round-trip and fails that bar"). So it previously PROXIED the fact
// from file-edit tool calls in the current transcript — which measured 0 fires
// across 805 sessions (mt#3755), because Minsky merges in a main-agent
// conversation whose implementation edits live in a dispatched subagent's
// transcript.
//
// `require-deploy-verification-before-merge` already fetches the merged PR's file
// list at merge time (ONE consolidated `fetchPrContext`, mt#2617) and already
// classifies it. This module lets it RECORD that verdict so the per-turn consumer
// can read it locally. Same producer/consumer hybrid as mt#2506's prod-state
// cache: the producer pays the network cost once per merge, the consumer stays
// local-fs only.
//
// Keying (PR #2734 R1). `session_pr_merge` takes EITHER `task` or `sessionId`
// (mt#3355), and the two sides see different things: the producer knows the
// RESOLVED task id, while the consumer sees only the raw tool_use input. So the
// producer writes the verdict under the resolved task id AND under each raw id
// it was called with, and the consumer looks up only the ID-BEARING fields of
// that input (`task`/`taskId`/`sessionId`/`session`) — never every string in it,
// which would let `repo` or free-text like `bypassReason` collide with another
// merge's key. A false match is worse than a miss: a miss falls back to the old
// proxy, a false match asserts another PR's deploy surface.
//
// @see mt#3819 — this module
// @see mt#3755 — the measurement that located the defect
// @see .minsky/hooks/require-deploy-verification-before-merge.ts — the producer
// @see .minsky/hooks/build-claim-injection-detector.ts — the consumer
// @see src/cockpit/prod-state-cache.ts — the mt#2506 pattern this mirrors

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as os from "node:os";
import { isDeploySurfaceFile, isLocalAppDeploySurfaceFile } from "./deploy-surface";

/** Filename under the Minsky state dir. */
const RECORD_FILENAME = "merge-deploy-surface.json";

/**
 * How many merge records to retain. Bounded so the file cannot grow without
 * limit on a machine that merges constantly; the consumer only ever asks about
 * a merge it just saw in the current transcript, so recent history is all that
 * is useful.
 */
export const MAX_RECORDS = 200;

/** One merge's verdict. */
export interface MergeDeploySurfaceRecord {
  /** True when the merged PR touched a Railway or local-app deploy/build surface. */
  hadDeploySurface: boolean;
  /** The matching surface paths, for the detector's reminder text. Empty when none. */
  deploySurfaceFiles: string[];
  /** ISO timestamp the producer wrote this. */
  recordedAt: string;
}

/** The on-disk shape: key (task id) -> verdict. */
export type MergeDeploySurfaceStore = Record<string, MergeDeploySurfaceRecord>;

/**
 * Resolve the Minsky state dir. Mirrors `inject-prod-state.ts`'s replication of
 * `getMinskyStateDir()` — same `process.env.HOME` precedence — because the hooks
 * tree is a separate module graph and cannot import the domain helper.
 */
function getStateDir(): string {
  const override = process.env["MINSKY_STATE_DIR"];
  if (override) return override;
  const xdgStateHome =
    process.env["XDG_STATE_HOME"] || join(process.env["HOME"] || os.homedir(), ".local/state");
  return join(xdgStateHome, "minsky");
}

export function getMergeDeploySurfaceRecordPath(): string {
  return join(getStateDir(), RECORD_FILENAME);
}

/**
 * Parse + validate the store. Returns an empty store on malformed content so
 * both sides fail OPEN (an unreadable record must never deny a merge or crash a
 * per-turn hook). Pure, for testability.
 */
export function parseStore(raw: string): MergeDeploySurfaceStore {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};

  const out: MergeDeploySurfaceStore = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const rec = value as Record<string, unknown>;
    if (typeof rec.hadDeploySurface !== "boolean") continue;
    if (typeof rec.recordedAt !== "string" || rec.recordedAt.length === 0) continue;
    const files = Array.isArray(rec.deploySurfaceFiles)
      ? rec.deploySurfaceFiles.filter((f): f is string => typeof f === "string")
      : [];
    out[key] = {
      hadDeploySurface: rec.hadDeploySurface,
      deploySurfaceFiles: files,
      recordedAt: rec.recordedAt,
    };
  }
  return out;
}

/**
 * Drop the oldest entries so at most {@link MAX_RECORDS} remain. Pure — the
 * trimming policy is the part worth testing, not the fs call around it.
 */
export function trimStore(
  store: MergeDeploySurfaceStore,
  max = MAX_RECORDS
): MergeDeploySurfaceStore {
  const entries = Object.entries(store);
  if (entries.length <= max) return store;
  // PR #2734 R1: tie-break by key. A single merge writes several keys with an
  // IDENTICAL `recordedAt` (the resolved task id plus the raw ids it was called
  // with), so timestamp alone leaves their relative order to object-key
  // iteration — making WHICH of a merge's own keys survives the trim
  // non-deterministic. Unparseable timestamps sort last rather than throwing.
  entries.sort((a, b) => {
    const at = Date.parse(a[1].recordedAt);
    const bt = Date.parse(b[1].recordedAt);
    const aSafe = Number.isNaN(at) ? -Infinity : at;
    const bSafe = Number.isNaN(bt) ? -Infinity : bt;
    if (aSafe !== bSafe) return bSafe - aSafe;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  return Object.fromEntries(entries.slice(0, max));
}

/**
 * The filesystem operations this module needs. Injected rather than imported at
 * the call sites so the round-trip is testable without touching a real disk
 * (`custom/no-real-fs-in-tests`); {@link REAL_FS} is the production wiring.
 */
export interface RecordFs {
  exists(path: string): boolean;
  readFile(path: string): string;
  writeFile(path: string, contents: string): void;
  mkdirp(path: string): void;
}

export const REAL_FS: RecordFs = {
  exists: (p) => existsSync(p),
  // `as string` is load-bearing after the mt#4089 move out of `.minsky/hooks/`:
  // `tsconfig.hooks.json` declares `types: ["bun", "node"]` while the ROOT project
  // this file now belongs to declares `types: ["bun"]`, under which `readFileSync`
  // is typed `string | Buffer` even with an explicit encoding. Same mechanism as the
  // mt#3755 tsconfig-project trap; the encoding argument already guarantees a string
  // at runtime.
  readFile: (p) => readFileSync(p, { encoding: "utf-8" }) as string,
  writeFile: (p, c) => writeFileSync(p, c, "utf-8"),
  mkdirp: (p) => {
    mkdirSync(p, { recursive: true });
  },
};

/** Read the store. Returns `{}` when absent/unreadable (fail-open). */
export function readStore(
  path: string = getMergeDeploySurfaceRecordPath(),
  fs: RecordFs = REAL_FS
): MergeDeploySurfaceStore {
  try {
    if (!fs.exists(path)) return {};
    return parseStore(fs.readFile(path));
  } catch {
    return {};
  }
}

/**
 * Record one merge's verdict. Never throws — the producer is a merge GATE, and a
 * failure to write this record must not change whether the merge is allowed.
 *
 * @returns true when the record was written.
 */
export function recordMergeDeploySurface(
  key: string,
  record: MergeDeploySurfaceRecord,
  path: string = getMergeDeploySurfaceRecordPath(),
  fs: RecordFs = REAL_FS
): boolean {
  if (!key) return false;
  try {
    const store = readStore(path, fs);
    store[key] = record;
    const trimmed = trimStore(store);
    const dir = dirname(path);
    if (!fs.exists(dir)) fs.mkdirp(dir);
    fs.writeFile(path, `${JSON.stringify(trimmed, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** The shape both writers see for a PR's changed file (octokit's `pulls.listFiles`). */
export interface MergeDeploySurfacePrFile {
  filename?: string | null;
  previous_filename?: string | null;
}

/**
 * Classify a merged PR's changed files and record the verdict under every key
 * (mt#4089). This is the SHARED derivation: `require-deploy-verification-before-merge`
 * (the PreToolUse hook) and `mergeSessionPr` (the domain merge path) both call it,
 * so the two writers cannot compute different verdicts for the same merge and
 * silently last-write-wins over each other.
 *
 * Why two writers at all. The hook is the only writer that existed until mt#4089,
 * which meant the record was populated ONLY for merges made through the MCP
 * `session_pr_merge` tool on a hook-enabled harness — a CLI merge, a `gh` merge, a
 * web-UI merge, or any harness without Claude Code hooks wrote nothing, and
 * `build-claim-injection-detector` then fell back to the pre-mt#3819 proxy that
 * mt#3755 measured as near-unsatisfiable. The domain writer closes every path the
 * hook cannot reach. The hook's own write is RETAINED rather than removed: the
 * thin-hooks RFC (Accepted 2026-08-11, mem#960) does move this logic hook→daemon,
 * but that removal belongs to the phase that stands up the daemon path, and both
 * remaining sub-decisions there are open asks. Two writes of the same verdict under
 * the same key are an idempotent overwrite, not a duplicate entry — the store is a
 * key→verdict map.
 *
 * Never throws. The hook path is a merge GATE and the domain path is the merge
 * ITSELF; a bookkeeping failure must not change whether a merge is allowed, nor
 * fail one that already happened.
 *
 * @returns the recorded verdict, or null if nothing was written.
 */
export function classifyAndRecordMergeDeploySurface(
  files: readonly MergeDeploySurfacePrFile[],
  keys: Iterable<string>,
  path: string = getMergeDeploySurfaceRecordPath(),
  fs: RecordFs = REAL_FS
): MergeDeploySurfaceRecord | null {
  try {
    // Matches the hook's original inline derivation exactly: a file counts when
    // EITHER its current or its previous path is a surface (so a rename INTO or
    // OUT OF a deploy surface is caught), across both the deployed-service and
    // the local-app pattern sets, de-duplicated.
    const matched: string[] = [];
    for (const f of files) {
      const currentMatches =
        isDeploySurfaceFile(f.filename) || isLocalAppDeploySurfaceFile(f.filename);
      const previousMatches =
        isDeploySurfaceFile(f.previous_filename) ||
        isLocalAppDeploySurfaceFile(f.previous_filename);
      if (!currentMatches && !previousMatches) continue;
      // PR #2958 R1: report the path that ACTUALLY matched, not always `filename`.
      // A rename OUT of a surface matches on `previous_filename` while `filename` is
      // some non-surface path — and this list is what the detector puts in its
      // reminder text, so emitting the new path there names a file that is not a
      // deploy surface and reads as a false positive. The pre-mt#4089 hook helpers
      // always mapped to `filename`, so this is a deliberate correction rather than
      // a parity break; a rename WITHIN the surface still contributes both ends.
      if (currentMatches && typeof f.filename === "string" && f.filename.length > 0) {
        matched.push(f.filename);
      }
      if (
        previousMatches &&
        typeof f.previous_filename === "string" &&
        f.previous_filename.length > 0
      ) {
        matched.push(f.previous_filename);
      }
    }
    const surfaceFiles = [...new Set(matched)];
    const record: MergeDeploySurfaceRecord = {
      hadDeploySurface: surfaceFiles.length > 0,
      deploySurfaceFiles: surfaceFiles,
      recordedAt: new Date().toISOString(),
    };
    let wrote = false;
    for (const key of keys) {
      if (recordMergeDeploySurface(key, record, path, fs)) wrote = true;
    }
    return wrote ? record : null;
  } catch {
    return null;
  }
}

/**
 * Look up the verdict for a merge, given every string reachable from that
 * merge's `session_pr_merge` tool_use input. The caller does not need to know
 * which field carried the id — `task`, `sessionId`, or both.
 *
 * Returns null when no candidate matches, which the consumer must treat as
 * "unknown", NOT as "no deploy surface".
 */
export function lookupMergeDeploySurface(
  candidateKeys: readonly string[],
  store: MergeDeploySurfaceStore
): MergeDeploySurfaceRecord | null {
  for (const key of candidateKeys) {
    const hit = store[key];
    if (hit) return hit;
  }
  return null;
}
