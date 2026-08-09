#!/usr/bin/env bun
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
  readFile: (p) => readFileSync(p, { encoding: "utf-8" }),
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
