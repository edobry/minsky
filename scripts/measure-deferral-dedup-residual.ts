#!/usr/bin/env bun
/**
 * mt#4407 — measure the `untaken-action` × `ask-routing-deferral` dedup residual, and run the
 * falsifier `## The deeper cause` recorded and left unrun.
 *
 * ## Why a script and not a jq one-liner
 *
 * This task's history is five causal hypotheses, four of them dead, several killed by a denominator
 * that was wrong rather than by a mechanism that was. The spec's own warning — *"Do not read 7/22 as
 * a hit rate"* — is about exactly that. So the join is written down, committed, and re-runnable,
 * which is what AT1 asks for: a later pass reproduces the number instead of re-deriving a different
 * one from the same logs.
 *
 * ## What it answers
 *
 * **Part A (AT1) — the residual, with a real denominator.** The denominator is
 * `ask-routing-deferral` FIRES, not `untaken-action` opportunity-shaped records. For each ARD fire,
 * classify:
 *
 * - `deduped` — its `suppressionReasons` carries `deduped-by-untaken-action-stop`. The handoff worked.
 * - `missed` — an `untaken-action` fire that WROTE overlap keys (injected path, `deferralOverlap:
 *   true`, no suppression) precedes it in the same session inside the pairing window, and this
 *   record injected anyway.
 * - `no-opportunity` — no such preceding fire. Nothing to dedup against; NOT a miss.
 * - `suppressed-otherwise` — suppressed for an unrelated reason, so the dedup never arbitrated.
 *
 * **Part B (AT2) — the recorded falsifier.** For every `missed` record, read the live turn-end scan
 * store for its session and ask whether a `stop-injected-overlap` entry exists there carrying a
 * phrase the sibling matched:
 *
 * - `key-present-phrase-matches` → the flag IS in the store under a DIFFERENT key. The Stop side did
 *   its job; only the addressing is wrong, and the candidate in `## The deeper cause` (scope the
 *   lookup to keys written since the last real prompt) is sufficient.
 * - `phrase-absent` → the store exists and does not carry the phrase. The flags are not being
 *   written on the turns that need them, and the defect is on the STOP side, not the read side.
 * - `store-absent` → no store file for that session. Reported as its own bucket and NEVER folded
 *   into `phrase-absent`: the store is live per-session state and an old session's file may simply
 *   be gone, which is silence rather than evidence.
 *
 * ## The failure this script refuses to have
 *
 * `calibrationLogPath` resolves through `findRepoRoot(CLAUDE_PROJECT_DIR ?? cwd)`, so running from a
 * SESSION WORKSPACE — itself a full clone — computes a different project key, finds no logs, and
 * reports a clean, plausible zero in every bucket. That is mem#573's cwd trap and mt#4960 hit it on
 * this exact corpus. An empty corpus therefore EXITS NON-ZERO naming the resolved path, rather than
 * reporting a result: a probe that returns the same answer whether or not the thing exists carries
 * no information (mem#704).
 *
 * ## Usage
 *
 *   bun scripts/measure-deferral-dedup-residual.ts                     # human-readable
 *   bun scripts/measure-deferral-dedup-residual.ts --json              # machine-readable
 *   bun scripts/measure-deferral-dedup-residual.ts --project-dir /path/to/main/repo
 *   bun scripts/measure-deferral-dedup-residual.ts --since 2026-08-30
 *
 * Exit 0 = measured. Exit 1 = the corpus was empty or unreadable (measurement did NOT run) — never
 * conflated with "measured, and the residual is zero".
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { calibrationLogPath } from "../.minsky/hooks/dispatcher";
import { STOP_INJECTED_OVERLAP_FAMILY } from "../.minsky/hooks/turn-end-scan-store";

/** The suppression reason the prompt-time guard records when the handoff worked. */
const DEDUP_REASON = "deduped-by-untaken-action-stop";

/**
 * How far back from an `ask-routing-deferral` fire to look for the `untaken-action` fire it should
 * have been deduped against.
 *
 * Grounded in the mechanism, not in a round number: `untaken-action` fires at `Stop` and
 * `ask-routing-deferral` at the NEXT `UserPromptSubmit`, so the gap is however long the principal
 * took to read the message and reply. 30 minutes covers a principal who steps away briefly; beyond
 * that the pairing is a guess, and a wrong pairing INFLATES `missed` — the direction that would
 * overstate the defect this task is measuring. Sensitivity at three windows is printed with the
 * result so the choice is visible rather than load-bearing.
 */
const PAIRING_WINDOW_MS = 30 * 60 * 1000;

/** Windows reported alongside the headline figure, so the pairing choice is auditable. */
const SENSITIVITY_WINDOWS_MS = [5 * 60 * 1000, PAIRING_WINDOW_MS, 4 * 60 * 60 * 1000];

const STORE_DIR = join(homedir(), ".local", "state", "minsky", "turn-end-scan");

interface CalibrationMatch {
  readonly class?: string;
  readonly phrase?: string;
  readonly context?: string;
}

interface CalibrationRecord {
  readonly timestamp?: string;
  readonly session_id?: string;
  readonly deferralOverlap?: boolean;
  readonly suppressionReasons?: string[];
  readonly matches?: CalibrationMatch[];
}

/**
 * A calibration record that survived parsing.
 *
 * `timestamp` and `session_id` are NARROWED to required here — `readJsonl` drops any record lacking
 * either, so every `ParsedRecord` has both. Declaring that in the type is what lets the rest of the
 * file read them without a non-null assertion at each use.
 */
export interface ParsedRecord extends CalibrationRecord {
  readonly at: number;
  readonly session: string;
  readonly timestamp: string;
  readonly session_id: string;
}

export type Bucket = "deduped" | "missed" | "no-opportunity" | "suppressed-otherwise";
export type FalsifierVerdict = "key-present-phrase-matches" | "phrase-absent" | "store-absent";

export interface Classified {
  readonly timestamp: string;
  readonly session: string;
  readonly bucket: Bucket;
  readonly phrases: string[];
  readonly pairedStopAt?: string;
  readonly falsifier?: FalsifierVerdict;
  readonly storePhraseSample?: string[];
}

function readJsonl(path: string): ParsedRecord[] {
  if (!existsSync(path)) return [];
  const out: ParsedRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let rec: CalibrationRecord;
    try {
      rec = JSON.parse(line) as CalibrationRecord;
    } catch {
      continue; // a torn trailing write is not a finding
    }
    const ts = rec.timestamp;
    const session = rec.session_id;
    if (typeof ts !== "string" || typeof session !== "string") continue;
    const at = Date.parse(ts);
    if (Number.isNaN(at)) continue;
    out.push({ ...rec, at, session, timestamp: ts, session_id: session });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Phrases a record matched, deduplicated and order-preserved. */
export function phrasesOf(rec: CalibrationRecord): string[] {
  const seen = new Set<string>();
  for (const m of rec.matches ?? []) {
    if (typeof m.phrase === "string" && m.phrase !== "") seen.add(m.phrase);
  }
  return [...seen];
}

function isSuppressed(rec: CalibrationRecord): boolean {
  return (rec.suppressionReasons ?? []).length > 0;
}

/**
 * An `untaken-action` record that actually WROTE overlap keys.
 *
 * Both conditions are load-bearing and were established by this task's 2026-08-25 pass: the field is
 * set on suppressed returns too, but keys are written only on the injecting path — so a suppressed
 * record can never dedup, and correctly so (the Stop guard said nothing, therefore the sibling
 * SHOULD speak).
 */
export function wroteOverlapKeys(rec: ParsedRecord): boolean {
  return rec.deferralOverlap === true && !isSuppressed(rec);
}

/** The most recent key-writing Stop fire in the same session within `windowMs`. */
export function pairStopFire(
  ard: ParsedRecord,
  stopBySession: Map<string, ParsedRecord[]>,
  windowMs: number
): ParsedRecord | undefined {
  const candidates = stopBySession.get(ard.session);
  if (!candidates) return undefined;
  let best: ParsedRecord | undefined;
  for (const s of candidates) {
    if (s.at >= ard.at) break; // sorted ascending; the Stop fire must precede
    if (ard.at - s.at > windowMs) continue;
    best = s; // keep advancing to the LATEST qualifying one
  }
  return best;
}

/**
 * Extract the `stop-injected-overlap` phrases from one store file's raw JSON.
 *
 * Pure, so the parsing rules — which family counts, how the phrase is recovered from the composite
 * key — are testable without touching a filesystem. The store is mutable per-session state, so a
 * test that read the real one would pass or fail on whatever happened to be on disk.
 */
export function parseStorePhrases(raw: string): string[] {
  const parsed = JSON.parse(raw) as { flagged?: unknown };
  if (!Array.isArray(parsed.flagged)) return [];
  const prefix = `|${STOP_INJECTED_OVERLAP_FAMILY}|`;
  const out: string[] = [];
  for (const entry of parsed.flagged) {
    if (typeof entry !== "string") continue;
    const idx = entry.indexOf(prefix);
    if (idx === -1) continue;
    out.push(entry.slice(idx + prefix.length));
  }
  return out;
}

/**
 * Look up one session's overlap phrases on disk. The IO shell around {@link parseStorePhrases}.
 *
 * `undefined` means the store could not be read AT ALL — absent or malformed. That is deliberately
 * distinct from `[]` (read, and it carries no overlap flags), because the classifier reports the
 * two as different verdicts: silence is not evidence of a Stop-side write failure.
 */
export function storePhrases(session: string, dir: string = STORE_DIR): string[] | undefined {
  const safe = session.replace(/[^A-Za-z0-9_-]/g, "_");
  const path = join(dir, `${safe}.json`);
  if (!existsSync(path)) return undefined;
  try {
    return parseStorePhrases(readFileSync(path, "utf8"));
  } catch {
    return undefined; // unreadable is store-absent, not phrase-absent
  }
}

/** How the classifier reaches a session's overlap flags. Injected so tests need no filesystem. */
export type PhraseLookup = (session: string) => string[] | undefined;

export function classify(
  ardRecords: ParsedRecord[],
  stopBySession: Map<string, ParsedRecord[]>,
  windowMs: number,
  lookupPhrases: PhraseLookup = (session) => storePhrases(session)
): Classified[] {
  return ardRecords.map((ard) => {
    const phrases = phrasesOf(ard);
    const reasons = ard.suppressionReasons ?? [];

    if (reasons.includes(DEDUP_REASON)) {
      return { timestamp: ard.timestamp, session: ard.session, bucket: "deduped", phrases };
    }
    if (reasons.length > 0) {
      return {
        timestamp: ard.timestamp,
        session: ard.session,
        bucket: "suppressed-otherwise",
        phrases,
      };
    }

    const paired = pairStopFire(ard, stopBySession, windowMs);
    if (!paired) {
      return { timestamp: ard.timestamp, session: ard.session, bucket: "no-opportunity", phrases };
    }

    // A miss. Run the falsifier against the store.
    const inStore = lookupPhrases(ard.session);
    let falsifier: FalsifierVerdict;
    if (inStore === undefined) {
      falsifier = "store-absent";
    } else if (phrases.some((p) => inStore.includes(p))) {
      falsifier = "key-present-phrase-matches";
    } else {
      falsifier = "phrase-absent";
    }

    return {
      timestamp: ard.timestamp,
      session: ard.session,
      bucket: "missed",
      phrases,
      pairedStopAt: paired.timestamp,
      falsifier,
      ...(inStore === undefined ? {} : { storePhraseSample: inStore.slice(0, 8) }),
    };
  });
}

function tally<T extends string>(items: readonly T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[i] = (out[i] ?? 0) + 1;
  return out;
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

function main(): void {
  const asJson = process.argv.includes("--json");
  const projectDir = argValue("--project-dir");
  const since = argValue("--since");

  const ardPath = calibrationLogPath("ask-routing-deferral", {
    ...(projectDir === undefined ? {} : { projectDir }),
  });
  const uaPath = calibrationLogPath("untaken-action", {
    ...(projectDir === undefined ? {} : { projectDir }),
  });

  let ardRecords = readJsonl(ardPath);
  let stopRecords = readJsonl(uaPath);

  // Fail closed. An empty corpus is the cwd trap (mem#573 / mt#4960), not a zero residual.
  if (ardRecords.length === 0 || stopRecords.length === 0) {
    process.stderr.write(
      `[measure-deferral-dedup-residual] EMPTY CORPUS — measurement did NOT run.\n` +
        `  ask-routing-deferral: ${ardRecords.length} record(s) at ${ardPath}\n` +
        `  untaken-action:       ${stopRecords.length} record(s) at ${uaPath}\n` +
        `  These paths resolve through findRepoRoot(CLAUDE_PROJECT_DIR ?? cwd). Running from a\n` +
        `  session workspace computes a different project key and finds nothing. Re-run with\n` +
        `  --project-dir pointing at the MAIN repo checkout.\n`
    );
    process.exit(1);
  }

  if (since !== undefined) {
    const cutoff = Date.parse(since);
    if (Number.isNaN(cutoff)) {
      process.stderr.write(`[measure-deferral-dedup-residual] unparseable --since: ${since}\n`);
      process.exit(1);
    }
    ardRecords = ardRecords.filter((r) => r.at >= cutoff);
    stopRecords = stopRecords.filter((r) => r.at >= cutoff);
    if (ardRecords.length === 0) {
      process.stderr.write(
        `[measure-deferral-dedup-residual] --since ${since} left 0 ask-routing-deferral records.\n`
      );
      process.exit(1);
    }
  }

  const keyWriting = stopRecords.filter(wroteOverlapKeys);
  const stopBySession = new Map<string, ParsedRecord[]>();
  for (const s of keyWriting) {
    const list = stopBySession.get(s.session) ?? [];
    list.push(s);
    stopBySession.set(s.session, list);
  }

  // `--window <minutes>` overrides the pairing window. Part A's `missed` count is sensitive to it
  // (see the sensitivity table), so Part B's verdict must be re-runnable at other windows rather
  // than resting on the default — a falsifier that only holds at one window is not a falsifier.
  const windowArg = argValue("--window");
  const windowMs = windowArg === undefined ? PAIRING_WINDOW_MS : Number(windowArg) * 60000;
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    process.stderr.write(`[measure-deferral-dedup-residual] bad --window: ${windowArg}\n`);
    process.exit(1);
  }

  const classified = classify(ardRecords, stopBySession, windowMs);
  const buckets = tally(classified.map((c) => c.bucket));
  const misses = classified.filter((c) => c.bucket === "missed");
  // Filter rather than assert: every `missed` record carries a verdict by construction, but a
  // narrowing the type system can check beats one it has to be told.
  const falsifier = tally(
    misses.map((c) => c.falsifier).filter((f): f is FalsifierVerdict => f !== undefined)
  );

  const sensitivity = SENSITIVITY_WINDOWS_MS.map((w) => ({
    windowMinutes: w / 60000,
    missed: classify(ardRecords, stopBySession, w).filter((c) => c.bucket === "missed").length,
  }));

  const result = {
    corpus: {
      askRoutingDeferralRecords: ardRecords.length,
      untakenActionRecords: stopRecords.length,
      untakenActionKeyWriting: keyWriting.length,
      sessionsWithKeyWritingFires: stopBySession.size,
      window: since ?? "all",
      pairingWindowMinutes: windowMs / 60000,
    },
    partA_residual: buckets,
    partB_falsifier: falsifier,
    sensitivity,
    misses: misses.map((m) => ({
      timestamp: m.timestamp,
      session: m.session,
      phrases: m.phrases,
      pairedStopAt: m.pairedStopAt,
      falsifier: m.falsifier,
      storePhraseSample: m.storePhraseSample ?? null,
    })),
  };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const ratable = (buckets["deduped"] ?? 0) + (buckets["missed"] ?? 0);
  process.stdout.write(
    `mt#4407 — untaken-action x ask-routing-deferral dedup residual\n\n` +
      `Corpus (${result.corpus.window}): ${result.corpus.askRoutingDeferralRecords} ask-routing-deferral, ` +
      `${result.corpus.untakenActionRecords} untaken-action (${result.corpus.untakenActionKeyWriting} key-writing ` +
      `across ${result.corpus.sessionsWithKeyWritingFires} sessions)\n` +
      `Pairing window: ${result.corpus.pairingWindowMinutes} min\n\n` +
      `Part A — residual, denominator = ask-routing-deferral fires\n${Object.entries(buckets)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `  ${k.padEnd(22)} ${v}`)
        .join("\n")}\n  ${"-".repeat(22)}\n` +
      `  arbitrated by the dedup: ${ratable}${
        ratable > 0
          ? ` -> ${((100 * (buckets["deduped"] ?? 0)) / ratable).toFixed(1)}% deduped\n`
          : `\n`
      }\nPart B — falsifier over the ${misses.length} miss(es)\n${
        misses.length === 0
          ? `  (no misses to test)\n`
          : `${Object.entries(falsifier)
              .sort((a, b) => b[1] - a[1])
              .map(([k, v]) => `  ${k.padEnd(28)} ${v}`)
              .join("\n")}\n`
      }\nSensitivity of "missed" to the pairing window\n${sensitivity
        .map((s) => `  ${String(s.windowMinutes).padStart(4)} min -> ${s.missed}`)
        .join("\n")}\n`
  );
}

if (import.meta.main) main();
