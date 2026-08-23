#!/usr/bin/env bun
// MessageDisplay hook: linkify entity refs in assistant output as it is
// displayed, leaving the stored transcript untouched (mt#2565).
//
// ## Why a hook rather than authoring discipline
//
// The deeplink rule used to ask the agent to hand-emit `[mt#N](minsky://...)`
// for every reference it wanted clickable. mt#3459 measured the result — 31
// linked vs 232 bare refs in one session — and decided to move linkification to
// the display surface instead of tuning the authoring ration. This is that move.
//
// ## The event's contract, read off the installed client (2.1.226)
//
//   input : { hook_event_name, turn_id, message_id, index, final, delta }
//   output: hookSpecificOutput { hookEventName: "MessageDisplay", displayContent }
//
// The schema's own description: "Fired with each batch of newly completed lines
// while an assistant message streams. Display-only: the stored message and what
// the model sees are untouched." Omitting `displayContent` (or returning the
// delta unchanged) displays the original, and the client degrades to the
// original delta if the hook fails — so every failure path here is a no-op.
//
// ## Why this is NOT on the guard dispatcher (ADR-028)
//
// ADR-028 D1 says one process per lifecycle event, and that is exactly what
// this is: the sole MessageDisplay hook. What it deliberately does NOT do is
// join the GUARD_REGISTRY, for two reasons the ADR itself supplies. The
// dispatcher resolves transcript candidates and writes fire-log records per
// invocation, and D7(5) rules out routing per-invocation IO into a hot path —
// and this event is the hottest one in the harness, firing once per batch of
// lines rather than once per turn, synchronously in the display path. Second,
// a guard's outcome is a decision (deny / inject context); this one's output is
// a TEXT TRANSFORM, which `GuardOutcome` cannot express. If a second
// MessageDisplay consumer ever appears, the right move is a
// `dispatch-messagedisplay.ts` entrypoint with a transform-shaped outcome —
// not a second settings.json command.
//
// Consequences for everything below: no domain bootstrap, no DB, no network, no
// transcript read. The only IO is one small state file, and it exists solely
// because a code fence opens in one delta and closes in another.
//
// Override: MINSKY_SKIP_TERMINAL_LINKIFY=1 displays every delta unchanged.
//
// @see .minsky/hooks/entity-linkify.ts — the pure transform
// @see docs/architecture/adr-028-guard-hook-dispatcher-consolidation.md — D1, D7(5)
// @see docs/architecture/adr-029-numeric-short-ids-foundation.md — why short ids are out of scope
// @see mt#2565 — this task; mt#3459 — the decision

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { readInput, writeOutput } from "./types";
import type { ClaudeHookInput, HookOutput } from "./types";
import { addCounts, emptyCounts, linkifyDelta } from "./entity-linkify";
import type { FenceState, LinkifyCounts, ShortIdMap } from "./entity-linkify";

export const TERMINAL_LINKIFY_OVERRIDE_ENV = "MINSKY_SKIP_TERMINAL_LINKIFY";

const STATE_FILENAME = "message-display-fence-state.json";

/**
 * Append-only fire log (mt#4145) — one line per COMPLETED message, not per
 * delta. This is the channel that lets anything downstream tell "the linkifier
 * ran and had nothing to rewrite" from "the linkifier did not run", which
 * nothing could distinguish before: the hook is off the guard dispatcher by
 * ADR-028 D1/D7(5), so it writes no fire-log record, and its own contract makes
 * every failure path a silent no-op. Three layers stood down on the strength of
 * it (the authoring ration in `cockpit-deeplinks.mdc`, mt#3897's carve-out,
 * mt#3937's disclosure) with no evidence underneath.
 *
 * Cost: ONE extra append per message. The per-delta hot path gains no IO — the
 * running tally rides the fence-state record that is already written per delta.
 * That is D7(5)'s prescribed shape ("cache + periodic sweep, splitting the
 * expensive read out of the per-turn hot path"), not a deviation from it.
 */
const FIRE_LOG_FILENAME = "linkify-fire-log.jsonl";

/**
 * Size cap. Past it the active log is ROTATED, not rewritten in place.
 *
 * The in-place version (read the file, write back the last N lines) was the
 * obvious implementation and it silently LOSES records: this hook runs one
 * process per delta and the state dir is shared across concurrent clients — as
 * `StoredFenceState`'s own header already notes — so any record appended
 * between the read and the write is discarded by the write. That is a durability
 * hole in the one file whose entire purpose is to be durable evidence
 * (PR #3026 R1).
 *
 * `rename` closes it rather than narrowing it. It is atomic, it destroys
 * nothing, and a concurrent writer holding the old path open keeps appending
 * into the renamed inode — so its records land in the rotated file instead of
 * being lost. Re-checking the size before an in-place rewrite, the cheaper fix,
 * would only shrink the race window; this removes it.
 *
 * Retention is therefore two files, and the reader consumes both. Dropping a
 * previous `.1` is a deliberate bound, not a race.
 */
const FIRE_LOG_MAX_BYTES = 262_144;
const FIRE_LOG_ROTATED_SUFFIX = ".1";

/**
 * Short-id map filename under the state dir (mt#3914). MUST match the PRODUCER's
 * literal in `src/cockpit/short-id-map-cache.ts` — this module lives in a
 * separate module graph and cannot import that constant, the same split
 * `inject-prod-state.ts` already carries. Keep the two in sync.
 */
const SHORT_ID_MAP_FILENAME = "short-id-map.json";

export interface MessageDisplayInput extends ClaudeHookInput {
  turn_id?: string;
  message_id?: string;
  index?: number;
  final?: boolean;
  delta?: string;
}

/**
 * The carried state. Exactly one message streams at a time in a given client, so
 * a single record suffices: a `message_id` that does not match the stored one
 * means a new message started and the fence flag resets. That is also what makes
 * the file self-cleaning — no per-message files accumulate.
 *
 * ## What happens when that assumption does not hold (PR #2763 R1)
 *
 * The file is shared per state dir, so two clients streaming at once — a second
 * Claude Code window, or a subagent whose output displays concurrently — write
 * over each other's record. There is no lock and no atomic rename, deliberately:
 * this runs synchronously in the display path, and the failure it would prevent
 * is not worth the cost.
 *
 * The blast radius of losing the race is one line's classification. A stolen
 * record makes `message_id` mismatch, which resets `inFence` to false — so a
 * fenced ref may be linked, or (after the other writer's fence opens) a prose
 * ref may stay bare. Neither corrupts the message: `displayContent` replaces
 * only the current delta, the stored transcript is untouched either way, and the
 * next delta re-reads the file. A torn or truncated read degrades identically,
 * which is why `readStoredState` returns null rather than throwing.
 *
 * If concurrent streaming ever becomes the common case, key the file by
 * `session_id` rather than adding a lock — it keeps the write single and
 * uncontended instead of making the hot path wait.
 */
interface StoredFenceState {
  messageId: string;
  inFence: boolean;
  /**
   * Running rewrite tally for THIS message, accumulated across its deltas
   * (mt#4145). Rides the record that is already written per delta so the
   * evidence channel costs no additional hot-path IO.
   *
   * OPTIONAL on purpose: a state file written by a build older than mt#4145 is
   * still on disk during any rollout, and one may be mid-stream at the moment
   * this ships. Typing it as required would make the read path assert against
   * a record that legitimately predates the field.
   */
  totals?: LinkifyCounts;
  /** How many deltas of this message have been processed. Optional for the same reason. */
  deltas?: number;
}

/**
 * One line of the fire log — written when a message COMPLETES (mt#4145).
 *
 * `deltas` is what makes a zero-rewrite record informative: `deltas > 0` with an
 * all-zero `totals` is "ran, nothing to rewrite", which is a completely
 * different fact from the absence of any record at all.
 */
export interface LinkifyFireRecord {
  at: string;
  messageId: string;
  deltas: number;
  totals: LinkifyCounts;
  /**
   * Set only when the client sent no `message_id` (PR #3026 R1). The record is
   * still written — this channel's whole job is to show the hook RAN, and
   * dropping the evidence to keep the log tidy would trade the primary signal
   * for a secondary one. A sentinel plus this flag keeps the anomaly explicit
   * rather than letting an empty string read as a real id downstream.
   */
  messageIdMissing?: true;
}

/** Sentinel for a record whose message carried no id. */
export const UNKNOWN_MESSAGE_ID = "(unknown)";

/** Resolve the Minsky state dir: MINSKY_STATE_DIR, else XDG_STATE_HOME/minsky, else ~/.local/state/minsky. */
export function getStateDir(): string {
  const override = process.env["MINSKY_STATE_DIR"];
  if (override) return override;
  const xdgStateHome =
    process.env["XDG_STATE_HOME"] || path.join(process.env["HOME"] || os.homedir(), ".local/state");
  return path.join(xdgStateHome, "minsky");
}

export function getFenceStatePath(): string {
  return path.join(getStateDir(), STATE_FILENAME);
}

/**
 * Coerce a persisted tally, tolerating a record written before mt#4145 added
 * the field. A missing or malformed `totals` degrades to zeros rather than
 * rejecting the whole record: the fence flag is what the DISPLAY depends on,
 * and losing it to a bookkeeping field would trade a correct render for a
 * counter. Under-counting one in-flight message is the right way to lose here.
 */
function coerceCounts(value: unknown): LinkifyCounts {
  const base = emptyCounts();
  if (typeof value !== "object" || value === null) return base;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(base) as (keyof LinkifyCounts)[]) {
    const n = record[key];
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) base[key] = n;
  }
  return base;
}

function readStoredState(): StoredFenceState | null {
  try {
    const raw = fs.readFileSync(getFenceStatePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredFenceState>;
    if (typeof parsed.messageId !== "string" || typeof parsed.inFence !== "boolean") return null;
    return {
      messageId: parsed.messageId,
      inFence: parsed.inFence,
      totals: coerceCounts(parsed.totals),
      deltas: typeof parsed.deltas === "number" && parsed.deltas >= 0 ? parsed.deltas : 0,
    };
  } catch {
    // intentional-swallow: a missing, truncated, or concurrently-rewritten state
    // file means "no carried fence state", which degrades to treating this delta
    // as top-level prose. The worst case is one code-fenced ref rendered as a
    // link; failing the hook instead would cost the whole message's display.
    return null;
  }
}

function writeStoredState(next: StoredFenceState | null): void {
  const target = getFenceStatePath();
  try {
    if (next === null) {
      fs.rmSync(target, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(next));
  } catch {
    // intentional-swallow: losing the carried flag degrades exactly like a
    // missing file above. This runs in the display path; it must never throw.
  }
}

export function getShortIdMapPath(): string {
  return path.join(getStateDir(), SHORT_ID_MAP_FILENAME);
}

/**
 * Where the fire log lives (mt#4145). Exported so the liveness check reads the
 * same path this writes rather than re-deriving the filename — the third copy
 * of a literal is how `SHORT_ID_MAP_FILENAME` above earned its keep-in-sync
 * comment, and there is no reason to repeat that here.
 */
export function getFireLogPath(): string {
  return path.join(getStateDir(), FIRE_LOG_FILENAME);
}

/** The rotated predecessor. The reader must consume this too, or rotation would
 *  present as evidence loss to every downstream verdict. */
export function getRotatedFireLogPath(): string {
  return `${getFireLogPath()}${FIRE_LOG_ROTATED_SUFFIX}`;
}

/**
 * Append one completed-message record, trimming the log when it exceeds the cap.
 *
 * Never throws, for the same reason every other write here does not: this runs
 * synchronously in the display path, and a bookkeeping failure must never cost
 * the message. Note what that means for the reader — an absent record is NOT
 * proof the hook did not run, only that no evidence survived. The liveness check
 * is written to say "no evidence" rather than "did not fire" for exactly this
 * reason.
 */
/**
 * Rotate the active log, at most one process at a time.
 *
 * `rename` alone is atomic but NOT sufficient here, which the first fix for
 * PR #3026 R1 missed and its own concurrency test then caught: with N hook
 * processes flushing at once, several can stat the oversize file before any of
 * them renames. The first rename moves the full log to `.1`; the second renames
 * the FRESH, nearly-empty log over the top of it — destroying exactly the
 * records rotation was supposed to preserve. Renaming atomically is not the same
 * as deciding to rename atomically.
 *
 * The `wx` open is the decision's mutex: it creates the lock file only if it
 * does not exist, atomically, so exactly one process proceeds. A loser skips
 * rotation entirely — the log stays slightly over its cap until the next flush,
 * which costs nothing. Under the lock the size is re-checked, so a process that
 * queued behind the winner does not rotate a file that is already fresh.
 */
function rotate(target: string): void {
  const lock = `${target}.rotate.lock`;

  let fd: number;
  try {
    fd = fs.openSync(lock, "wx");
  } catch {
    // EEXIST: another process holds the decision. Clear a stale lock left by a
    // process that died mid-rotation, but never steal a live one — a lock we
    // cannot age out is still better than a double rename.
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > 60_000) fs.rmSync(lock, { force: true });
    } catch {
      // intentional-swallow: the lock vanished under us, i.e. the winner
      // finished. Either way this pass does not rotate.
    }
    return;
  }

  try {
    // Re-check under the lock: a process that blocked on the open above may be
    // looking at a size reading taken before the winner rotated.
    if (fs.statSync(target).size > FIRE_LOG_MAX_BYTES) {
      fs.renameSync(target, getRotatedFireLogPath());
    }
  } catch {
    // intentional-swallow: a failed rotation leaves an oversize log, which is a
    // disk-space concern. The display, and the evidence already written, are
    // both untouched.
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // intentional-swallow: nothing actionable, and the unlink below is what
      // actually releases the lock.
    }
    fs.rmSync(lock, { force: true });
  }
}

function appendFireRecord(record: LinkifyFireRecord): void {
  const target = getFireLogPath();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${JSON.stringify(record)}\n`);

    let size = 0;
    try {
      size = fs.statSync(target).size;
    } catch {
      // intentional-swallow: if the size cannot be read, skip rotation. An
      // oversized log is a disk-space concern, not a correctness one.
      return;
    }
    if (size <= FIRE_LOG_MAX_BYTES) return;
    rotate(target);
  } catch {
    // intentional-swallow: see the doc comment — the display outranks the
    // evidence channel, always.
  }
}

/** The on-disk record written by the producer (mirrors `ShortIdMapRecord` there). */
interface StoredShortIdMap {
  refreshedAt: number;
  entries: ShortIdMap;
}

/**
 * Parse the map record. Exported so the shape contract is testable without a
 * file; returns null on anything unexpected so the caller degrades to "no map",
 * which leaves every short id bare rather than risking a wrong target.
 */
export function parseShortIdMap(raw: string): ShortIdMap | null {
  const parsed = JSON.parse(raw) as Partial<StoredShortIdMap>;
  const entries = parsed.entries;
  if (typeof entries !== "object" || entries === null) return null;
  return entries;
}

/**
 * Read the short-id map. This is the ONLY IO mt#3914 adds to the hot path, and
 * it is deliberately unconditional rather than staleness-gated: an entry's
 * short-id -> UUID binding is immutable once minted, so an OLD map is never
 * WRONG — only incomplete, which degrades to bare. That is the opposite of
 * `inject-prod-state`, whose snapshot goes stale in the sense that matters and
 * therefore has to render its own age.
 *
 * EXPORTED for `turn-end-bare-ref-scan` (mt#3960), which must decide whether a
 * bare short id will be repaired downstream. That question is only answerable
 * against the map THIS path reads, so the guard calls this function rather than
 * re-deriving the filename and the degradation policy — the third copy of a
 * literal whose second copy already carries a "keep the two in sync" comment.
 * Importing this module runs nothing: its entry point is `import.meta.main`.
 */
export function readShortIdMap(): ShortIdMap | undefined {
  try {
    return parseShortIdMap(fs.readFileSync(getShortIdMapPath(), "utf8")) ?? undefined;
  } catch {
    // intentional-swallow: absent or unreadable means "resolve nothing", which
    // is the pre-mt#3914 behavior for every short id. Never fail the display.
    return undefined;
  }
}

function isOverrideTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/**
 * The decision, extracted so it is observable without stdin, a state file, or a
 * process: given a delta and whatever state was carried, what should be
 * displayed and what state should be carried forward?
 *
 * `null` for `display` means "emit nothing" — the client then shows the
 * original delta, which is both the no-change case and every failure case.
 */
export function decideDisplay(
  input: MessageDisplayInput,
  stored: StoredFenceState | null,
  shortIdMap?: ShortIdMap,
  now: () => string = () => new Date().toISOString()
): {
  display: string | null;
  nextState: StoredFenceState | null;
  /** Non-null exactly on the delta that ENDS a message — the record to append. */
  flush: LinkifyFireRecord | null;
} {
  const delta = input.delta ?? "";
  const messageId = input.message_id ?? "";
  const sameMessage = stored !== null && stored.messageId === messageId;
  const carried: FenceState = sameMessage ? { inFence: stored.inFence } : { inFence: false };
  // `?? emptyCounts()` / `?? 0` are NOT redundant with `readStoredState`'s
  // coercion. This function is exported and reachable with a hand-built record —
  // a caller that predates mt#4145's fields, or a state file written by an older
  // build still on disk. It runs in the display path, where a throw costs the
  // message, so the bookkeeping fields degrade instead of asserting.
  const totals = sameMessage ? (stored.totals ?? emptyCounts()) : emptyCounts();
  let deltas = sameMessage ? (stored.deltas ?? 0) : 0;

  const buildFlush = (): LinkifyFireRecord => ({
    at: now(),
    messageId: messageId === "" ? UNKNOWN_MESSAGE_ID : messageId,
    deltas,
    totals,
    ...(messageId === "" ? { messageIdMissing: true as const } : {}),
  });

  if (delta === "") {
    // The final flush is empty when the message ends on a newline; treat `final`
    // as the end-of-message signal regardless, and drop the carried state.
    if (input.final !== true) return { display: null, nextState: stored, flush: null };
    return { display: null, nextState: null, flush: buildFlush() };
  }

  const result = linkifyDelta(delta, carried, { final: input.final === true, shortIdMap });
  addCounts(totals, result.counts);
  deltas += 1;

  const isFinal = input.final === true;
  const nextState: StoredFenceState | null = isFinal
    ? null
    : { messageId, inFence: result.state.inFence, totals, deltas };

  return {
    display: result.text === delta ? null : result.text,
    nextState,
    flush: isFinal ? buildFlush() : null,
  };
}

async function main(): Promise<void> {
  if (isOverrideTruthy(process.env[TERMINAL_LINKIFY_OVERRIDE_ENV])) return;

  let input: MessageDisplayInput;
  try {
    input = await readInput<MessageDisplayInput>();
  } catch {
    // intentional-swallow: unparseable stdin means display the original delta.
    return;
  }
  if (input.hook_event_name !== "MessageDisplay") return;

  const { display, nextState, flush } = decideDisplay(input, readStoredState(), readShortIdMap());
  writeStoredState(nextState);
  // Both writes land BEFORE the single stdout JSON below, and neither touches
  // stdout — mem#832 measured that ANY extra stdout byte makes the harness
  // discard a hook's whole output, so an evidence channel written the obvious
  // way would have silently disabled the very linkification it exists to prove.
  if (flush !== null) appendFireRecord(flush);
  if (display === null) return;

  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: "MessageDisplay",
      displayContent: display,
    },
  };
  writeOutput(output);
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    // The client falls back to the original delta when a hook fails, so the
    // display is safe either way; stderr keeps the cause visible.
    process.stderr.write(
      `[linkify-message-display] fail-open: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
}
