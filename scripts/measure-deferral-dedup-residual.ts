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
 * **Part B (AT2) — the recorded falsifier, bounded to the PAIRED TURN.** The spec's question is
 * time-bounded: *"whether an overlap key written BETWEEN THE PREVIOUS REAL PROMPT AND THE SIBLING'S
 * RUN POSITION exists in the store AND carries the phrase the sibling matched."* The store carries
 * no timestamps, so the bound is reconstructed from the paired Stop record instead of approximated
 * by session:
 *
 * `untaken-action` writes `final_message_tail` (the last `TAIL_WINDOW_CHARS` of the message it
 * judged) on the same record that wrote the keys, and `overlapTurnKey` hashes the last 400
 * characters of the NORMALIZED message. So recomputing `overlapTurnKey(final_message_tail,
 * turnKeyForMessage)` reproduces the exact key that Stop fire wrote — provided the normalized tail
 * still has 400 characters to hash. Verdicts:
 *
 * - `key-present-exact` — the store holds `<that turn's key>|stop-injected-overlap|<a phrase the
 *   sibling matched>`. **This is the spec's question answered.** The Stop side wrote the flag for
 *   THIS turn and the read side looked under a different key.
 * - `phrase-present-other-key` — the phrase is in the store, but under some OTHER key. Consistent
 *   with a different turn of the same session having flagged the same stock phrase, so it is
 *   reported separately and is NOT evidence for the addressing change.
 * - `phrase-absent` — the session's store DOES hold overlap flags, and none of them matches. This is
 *   the only verdict that is genuine evidence of a Stop-side residual.
 * - `store-empty-or-absent` — the session has no overlap flags at all. Its own bucket, deliberately
 *   never folded into `phrase-absent`. `readFlagged` fails OPEN to an empty set, so "no store file"
 *   and "a store holding nothing" are one observation through it, and neither is evidence that the
 *   Stop side failed to write: the store is live per-session state and an old session's file may
 *   simply be gone. Recovering the distinction would mean re-deriving the store path here, which is
 *   the duplication PR #3639 R1 flagged; reporting the ambiguity is the cheaper honest answer.
 * - `tail-too-short` — the normalized tail is under 400 chars, so the key cannot be reconstructed
 *   faithfully. Reported rather than guessed.
 *
 * An earlier revision of this script asked only "is this phrase anywhere in this session's store?",
 * which drops the time bound the spec's question carries and inflates the affirmative answer with
 * flags written on unrelated turns. Caught by `minsky-reviewer[bot]` on PR #3639 R1 (BLOCKING).
 *
 * ## The failure this script refuses to have
 *
 * `calibrationLogPath` resolves through `findRepoRoot(CLAUDE_PROJECT_DIR ?? cwd)`, so running from a
 * SESSION WORKSPACE — itself a full clone — computes a different project key, finds no logs, and
 * reports a clean, plausible zero in every bucket. That is mem#573's cwd trap and mt#4960 hit it on
 * this exact corpus. An empty corpus therefore EXITS NON-ZERO naming the resolved path, rather than
 * reporting a result: a probe that returns the same answer whether or not the thing exists carries
 * no information (mem#704). The check runs on the raw corpus AND again after `--since` filtering,
 * because a window that filters either log to nothing is the same empty-corpus condition arriving
 * later.
 *
 * ## Usage
 *
 *   bun scripts/measure-deferral-dedup-residual.ts                     # human-readable
 *   bun scripts/measure-deferral-dedup-residual.ts --json              # machine-readable
 *   bun scripts/measure-deferral-dedup-residual.ts --project-dir /path/to/main/repo
 *   bun scripts/measure-deferral-dedup-residual.ts --since 2026-08-30 --window 30
 *
 * Exit 0 = measured. Exit 1 = the corpus was empty or unreadable (measurement did NOT run) — never
 * conflated with "measured, and the residual is zero".
 */
import { existsSync, readFileSync } from "node:fs";

import { calibrationLogPath } from "../.minsky/hooks/dispatcher";
import {
  STOP_INJECTED_OVERLAP_FAMILY,
  overlapTurnKey,
  readFlagged,
} from "../.minsky/hooks/turn-end-scan-store";
import { turnKeyForMessage } from "../.minsky/hooks/turn-end-untaken-action-scan";

/** The suppression reason the prompt-time guard records when the handoff worked. */
const DEDUP_REASON = "deduped-by-untaken-action-stop";

/**
 * Characters `overlapTurnKey` hashes. Mirrors `OVERLAP_TAIL_CHARS` in `turn-end-scan-store.ts`,
 * which is module-private — used ONLY to decide whether a reconstructed tail is long enough to
 * reproduce the key faithfully, never to recompute one (that goes through `overlapTurnKey` itself,
 * so the hashing rule has exactly one definition).
 */
const OVERLAP_TAIL_CHARS = 400;

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
  readonly final_message_tail?: string;
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

export type FalsifierVerdict =
  | "key-present-exact"
  | "phrase-present-other-key"
  | "phrase-absent"
  | "store-empty-or-absent"
  | "tail-too-short";

export interface Classified {
  readonly timestamp: string;
  readonly session: string;
  readonly bucket: Bucket;
  readonly phrases: string[];
  readonly pairedStopAt?: string;
  readonly falsifier?: FalsifierVerdict;
  readonly reconstructedKey?: string;
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
 * The overlap key a given Stop fire wrote, reconstructed from the tail it recorded.
 *
 * `undefined` when the normalized tail is shorter than the hash window — the key would then be a
 * hash of less text than the real one and would never match, so a miss would be indistinguishable
 * from a genuine absence. Reported as `tail-too-short` rather than guessed.
 */
export function reconstructOverlapKey(stopRecord: CalibrationRecord): string | undefined {
  const tail = stopRecord.final_message_tail;
  if (typeof tail !== "string") return undefined;
  if (tail.replace(/\s+/g, " ").trim().length < OVERLAP_TAIL_CHARS) return undefined;
  return overlapTurnKey(tail, turnKeyForMessage);
}

/** One session's `stop-injected-overlap` flags, as `(key, phrase)` pairs. Empty when there are none. */
export type FlagLookup = (session: string) => Array<{ key: string; phrase: string }>;

/**
 * Read one session's `stop-injected-overlap` flags through the store module's own reader.
 *
 * Going through `readFlagged` rather than re-deriving the path is what keeps the store's layout,
 * its session-id sanitizer and its fail-open posture in ONE place — PR #3639 R1 flagged the earlier
 * duplication as a drift risk (NON-BLOCKING) and it was right: a change to the store's path scheme
 * would have left this script silently reading nothing.
 *
 * `readFlagged` fails OPEN to an empty set, so an absent store and an empty one are identical
 * through it. That collapse is REPORTED rather than worked around: an empty result becomes the
 * `store-empty-or-absent` verdict, which is explicitly not evidence of a Stop-side write failure.
 */
export function readOverlapFlags(session: string): Array<{ key: string; phrase: string }> {
  const prefix = `|${STOP_INJECTED_OVERLAP_FAMILY}|`;
  const out: Array<{ key: string; phrase: string }> = [];
  for (const entry of readFlagged(session)) {
    const idx = entry.indexOf(prefix);
    if (idx === -1) continue;
    out.push({ key: entry.slice(0, idx), phrase: entry.slice(idx + prefix.length) });
  }
  return out;
}

export function classify(
  ardRecords: ParsedRecord[],
  stopBySession: Map<string, ParsedRecord[]>,
  windowMs: number,
  lookupFlags: FlagLookup = readOverlapFlags
): Classified[] {
  return ardRecords.map((ard): Classified => {
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

    const base = {
      timestamp: ard.timestamp,
      session: ard.session,
      bucket: "missed" as const,
      phrases,
      pairedStopAt: paired.timestamp,
    };

    const flags = lookupFlags(ard.session);
    if (flags.length === 0) return { ...base, falsifier: "store-empty-or-absent" };

    const expectedKey = reconstructOverlapKey(paired);
    if (expectedKey === undefined) return { ...base, falsifier: "tail-too-short" };

    const wanted = new Set(phrases);
    const exact = flags.some((f) => f.key === expectedKey && wanted.has(f.phrase));
    if (exact) {
      return { ...base, falsifier: "key-present-exact", reconstructedKey: expectedKey };
    }
    const otherKey = flags.some((f) => wanted.has(f.phrase));
    return {
      ...base,
      falsifier: otherKey ? "phrase-present-other-key" : "phrase-absent",
      reconstructedKey: expectedKey,
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

/** Parse `--window <minutes>` into ms. `undefined` for absent; `null` for present-but-unusable. */
export function resolveWindowMs(arg: string | undefined): number | null | undefined {
  if (arg === undefined) return undefined;
  const ms = Number(arg) * 60000;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * Whether a corpus pair is unusable. BOTH logs are required: the falsifier needs Stop-side records,
 * so a window that leaves zero of them measures nothing even with ARD records in hand.
 *
 * PR #3639 R1 (BLOCKING): the post-`--since` check tested only the ARD side, so a `--since` that
 * filtered every Stop record away produced a full report in which every fire was `no-opportunity` —
 * structurally identical to a corpus where the dedup had nothing to do.
 */
export function corpusIsEmpty(ardCount: number, stopCount: number): boolean {
  return ardCount === 0 || stopCount === 0;
}

function failEmpty(
  reason: string,
  ardCount: number,
  stopCount: number,
  ardPath: string,
  uaPath: string
): never {
  process.stderr.write(
    `[measure-deferral-dedup-residual] ${reason} — measurement did NOT run.\n` +
      `  ask-routing-deferral: ${ardCount} record(s) at ${ardPath}\n` +
      `  untaken-action:       ${stopCount} record(s) at ${uaPath}\n` +
      `  Both logs are required: with zero Stop-side records every fire classifies as\n` +
      `  no-opportunity, which is indistinguishable from a corpus the dedup had nothing to do in.\n` +
      `  These paths resolve through findRepoRoot(CLAUDE_PROJECT_DIR ?? cwd). Running from a\n` +
      `  session workspace computes a different project key and finds nothing. Re-run with\n` +
      `  --project-dir pointing at the MAIN repo checkout.\n`
  );
  process.exit(1);
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
  if (corpusIsEmpty(ardRecords.length, stopRecords.length)) {
    failEmpty("EMPTY CORPUS", ardRecords.length, stopRecords.length, ardPath, uaPath);
  }

  if (since !== undefined) {
    const cutoff = Date.parse(since);
    if (Number.isNaN(cutoff)) {
      process.stderr.write(`[measure-deferral-dedup-residual] unparseable --since: ${since}\n`);
      process.exit(1);
    }
    ardRecords = ardRecords.filter((r) => r.at >= cutoff);
    stopRecords = stopRecords.filter((r) => r.at >= cutoff);
    // Same condition, arriving later: the window, not the path, emptied it.
    if (corpusIsEmpty(ardRecords.length, stopRecords.length)) {
      failEmpty(
        `EMPTY AFTER --since ${since}`,
        ardRecords.length,
        stopRecords.length,
        ardPath,
        uaPath
      );
    }
  }

  const windowOverride = resolveWindowMs(argValue("--window"));
  if (windowOverride === null) {
    process.stderr.write(
      `[measure-deferral-dedup-residual] bad --window: ${argValue("--window")}\n`
    );
    process.exit(1);
  }
  const windowMs = windowOverride ?? PAIRING_WINDOW_MS;

  const keyWriting = stopRecords.filter(wroteOverlapKeys);
  const stopBySession = new Map<string, ParsedRecord[]>();
  for (const s of keyWriting) {
    const list = stopBySession.get(s.session) ?? [];
    list.push(s);
    stopBySession.set(s.session, list);
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
      reconstructedKey: m.reconstructedKey ?? null,
    })),
  };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const ratable = (buckets["deduped"] ?? 0) + (buckets["missed"] ?? 0);
  const bucketLines = Object.entries(buckets)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `  ${k.padEnd(24)} ${v}`)
    .join("\n");
  const falsifierLines =
    misses.length === 0
      ? "  (no misses to test)"
      : Object.entries(falsifier)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `  ${k.padEnd(24)} ${v}`)
          .join("\n");
  const sensitivityLines = sensitivity
    .map((s) => `  ${String(s.windowMinutes).padStart(4)} min -> ${s.missed}`)
    .join("\n");
  const rate =
    ratable > 0 ? ` -> ${((100 * (buckets["deduped"] ?? 0)) / ratable).toFixed(1)}% deduped` : "";

  process.stdout.write(
    `mt#4407 — untaken-action x ask-routing-deferral dedup residual\n\n` +
      `Corpus (${result.corpus.window}): ${result.corpus.askRoutingDeferralRecords} ask-routing-deferral, ` +
      `${result.corpus.untakenActionRecords} untaken-action (${result.corpus.untakenActionKeyWriting} key-writing ` +
      `across ${result.corpus.sessionsWithKeyWritingFires} sessions)\n` +
      `Pairing window: ${result.corpus.pairingWindowMinutes} min\n\n` +
      `Part A — residual, denominator = ask-routing-deferral fires\n${bucketLines}\n` +
      `  ${"-".repeat(24)}\n` +
      `  arbitrated by the dedup: ${ratable}${rate}\n\n` +
      `Part B — falsifier over the ${misses.length} miss(es), key bounded to the paired turn\n` +
      `${falsifierLines}\n\n` +
      `Sensitivity of "missed" to the pairing window\n${sensitivityLines}\n`
  );
}

if (import.meta.main) main();
