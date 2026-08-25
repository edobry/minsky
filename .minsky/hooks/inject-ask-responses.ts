#!/usr/bin/env bun
// UserPromptSubmit hook: tell the agent that an ask it filed has been answered (mt#3564).
//
// The read half of the answered-ask loop. `stamp-ask-conversation.ts` records which
// conversation filed which ask; the cockpit sweep resolves those asks' current state
// into `ask-state-cache.json`; this hook joins the two and injects a notice on the next
// turn of the conversation that asked.
//
// ## Why this exists
//
// Filing an ask and continuing to work is the dominant case, and nothing told the agent
// the answer arrived. In the originating incident (ask#6687, 2026-08-01) an operator
// answered ~16h after filing, and across that window the agent reported the ask's state
// four times as "awaiting your call" — each time restating what it remembered filing
// rather than what was true. `asks_wait-for-response` only fits file-and-wait; nobody
// blocks for six hours.
//
// The turn-END sibling `turn-end-stale-state-assertion-scan.ts` (mt#4199) catches that
// assertion as it is being written. This is the other seam: stop it forming.
//
// ## Cost discipline
//
// Reads TWO local files and nothing else — no database, no network. A cold hook DB
// connect measures 3.3-5.5s against a dispatcher budget (ADR-028 D7(5)), so the
// expensive read lives in the cockpit sweep and this hook only joins its output.
//
// ## Why cache staleness is not checked
//
// The sibling `calibration-review-cadence-detector.ts` refuses to assert a state from a
// snapshot older than 30 minutes, because it renders a DISPOSITION and a stale snapshot
// could show an ask still open that has since settled. This hook has the opposite
// exposure: it asserts only that an ask HAS settled, and settlement is durable — a
// stale snapshot can make this hook LATE, never WRONG. So a stale cache is allowed to
// serve; the failure it produces is a notice a few minutes late, which is the same
// failure a longer sweep interval would produce and strictly better than silence.
//
// Override: MINSKY_HOOK_OVERRIDE=inject-ask-responses (ADR-028 D3 — no new per-guard
// env var is minted, per CLAUDE.md §Hook Files).
//
// @see mt#3564 — this task
// @see .minsky/hooks/stamp-ask-conversation.ts — the attribution writer
// @see src/cockpit/ask-state-cache.ts — the producer whose snapshot this reads
// @see .minsky/hooks/inject-dispatch-watchdog.ts — the producer/consumer precedent

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readInput, writeOutput } from "./types";
import type { ClaudeHookInput, HookOutput } from "./types";
import type { DispatchContext, GuardOutcome } from "./registry";
import { safeTruncate } from "@minsky/shared/safe-truncate";
import { readAskConversationMap, askIdsForConversation } from "./ask-conversation-map";

/** The guard name this hook answers to under `MINSKY_HOOK_OVERRIDE`. */
export const GUARD_NAME = "inject-ask-responses";

/**
 * Cache location — MUST match `src/cockpit/ask-state-cache.ts`
 * (ASK_STATE_CACHE_FILENAME + getStateDir). That module lives in a separate module
 * graph and cannot be imported here; keep the two in sync.
 */
const ASK_STATE_CACHE_FILENAME = "ask-state-cache.json";

/** Where this hook records which responses it has already announced. */
const INJECTION_WATERMARK_FILENAME = "ask-response-injections.json";

// NOTE (PR #3257 R1): this file deliberately carries NO copy of the open-ask state list.
// The producer precomputes `open` onto every entry, and its docblock says why in as many
// words — "so the hook needs no policy knowledge of its own and the two cannot drift."
// An earlier revision duplicated the set here and re-derived openness from `state`,
// which is exactly the drift that design prevents: widening `OPEN_ASK_STATES` on the
// producer would have silently left this consumer on the old membership.

/**
 * How many asks are enumerated before eliding.
 *
 * The merged injection block is capped (`MERGED_CONTEXT_BUDGET_CHARS`, 6627 as of
 * 2026-08-22) and over-budget fragments are DROPPED BY PRIORITY — so an unbounded
 * render risks dropping this very notice, reproducing the exact gap the hook exists to
 * close.
 *
 * These constants are not taste; they are chosen so the STRUCTURAL worst case lands
 * under 600 chars and this guard therefore stays OUT of the top-five conditional bucket
 * `MERGED_CONTEXT_BUDGET_CHARS` is derived from. Entering that bucket would force the
 * shared budget up for every guard.
 *
 * MEASURED, not hand-derived: 586 chars, by saturating every field at once (99 settled
 * asks so the elision line renders, a 10-char shortId, an over-length title, an
 * over-length chosen, the longer of the two closers). Past the enumeration cap the only
 * remaining variation is per-field width, so saturating each gives a true maximum
 * rather than a sample — the distinction mt#4234 exists to enforce. The first
 * hand-derivation of this number said 588 and was wrong in the other direction too: it
 * assumed the producer's truncation held, and the hook did not cap `chosen` at all
 * (real render 664). `formatAskResponses`'s test asserts the 590 the registry declares.
 */
export const MAX_ENUMERATED_ASKS = 2;

/** Truncation bound for a rendered title, so one long ask cannot dominate the block. */
export const MAX_TITLE_CHARS = 60;

/**
 * Truncation bound for the rendered `chosen` value.
 *
 * The producer already caps this (`MAX_CHOSEN_CHARS` in `src/cockpit/ask-state-cache.ts`),
 * so this is deliberately a SECOND cap at the render site rather than a redundant one.
 * The cache is a file on disk written by a separate module graph: a snapshot left by an
 * older producer, a hand-edited file, or a future widening of the producer's cap would
 * otherwise flow straight into the injected block and break the structural bound the
 * registry annotation declares. The guard whose size annotation is at stake is the one
 * that should enforce it.
 *
 * Caught by `inject-ask-responses.test.ts`'s saturated worst-case assertion, not by
 * review — the hook originally trusted the producer and rendered 664 chars against a
 * declared 590.
 */
export const MAX_CHOSEN_RENDER_CHARS = 100;

/** Resolve the Minsky state dir: MINSKY_STATE_DIR, else XDG_STATE_HOME/minsky, else ~/.local/state/minsky. */
function getStateDir(): string {
  const override = process.env["MINSKY_STATE_DIR"];
  if (override) return override;
  const xdgStateHome =
    process.env["XDG_STATE_HOME"] || path.join(process.env["HOME"] || os.homedir(), ".local/state");
  return path.join(xdgStateHome, "minsky");
}

export function getAskStateCachePath(): string {
  return path.join(getStateDir(), ASK_STATE_CACHE_FILENAME);
}

export function getInjectionWatermarkPath(): string {
  return path.join(getStateDir(), INJECTION_WATERMARK_FILENAME);
}

/** One resolved ask in the producer's snapshot (mirrors `src/cockpit/ask-state-cache.ts`). */
export type AskStateEntry =
  | {
      found: true;
      state: string;
      open: boolean;
      shortId?: string;
      title?: string;
      respondedAt?: string;
      chosen?: string;
      /**
       * Set when the tool-call seam (mt#4476) already delivered this answer to the
       * filing conversation. Present here because the two seams cannot share a
       * watermark directly — this hook writes no DB by design (mem#672), so the
       * cockpit sweep carries the tool-call seam's `drained_at` across for us.
       */
      wakeDeliveredAt?: string;
    }
  | { found: false };

export interface AskStateCacheRecord {
  checkedAt: string;
  asks: Record<string, AskStateEntry>;
}

/** A settled ask this conversation filed, ready to render. */
export interface SettledAsk {
  askId: string;
  shortId?: string;
  title?: string;
  chosen?: string;
  state: string;
  /**
   * Whether the operator actually RESPONDED, as opposed to the ask reaching a terminal
   * state some other way (cancelled debris, expiry). Both are worth telling the agent —
   * in each case it is no longer true that the ask awaits the principal — but they are
   * different facts and the render must not conflate them into "answered".
   */
  answered: boolean;
  /**
   * The value the dedupe watermark compares against. Changes when the ask is re-answered
   * or edited, which is what lets SC3's "a re-answered ask may fire again" hold without
   * re-firing on every subsequent turn.
   */
  marker: string;
}

/** Read a JSON file, or return null on absent/unreadable/unparseable. */
function readJson(filePath: string): unknown | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(String(fs.readFileSync(filePath, "utf-8")));
  } catch {
    // intentional-swallow: every input to this hook is best-effort local state; an
    // unreadable file means "no notice this turn", which is the fail-open posture every
    // sibling injection hook uses.
    return null;
  }
}

/** Coerce a parsed value into a cache record, or null when it is not one. */
export function coerceCacheRecord(parsed: unknown): AskStateCacheRecord | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { checkedAt, asks } = parsed as { checkedAt?: unknown; asks?: unknown };
  if (typeof checkedAt !== "string") return null;
  if (!asks || typeof asks !== "object" || Array.isArray(asks)) return null;
  return { checkedAt, asks: asks as Record<string, AskStateEntry> };
}

/**
 * Select the asks belonging to `conversationId` that have SETTLED and have not already
 * been announced.
 *
 * Pure over its inputs — the whole selection policy unit-tests with no filesystem.
 */
export function selectSettledAsks(
  askIds: string[],
  cache: AskStateCacheRecord | null,
  alreadyInjected: Record<string, string>,
  shortIdsByAskId: Record<string, string | undefined> = {}
): SettledAsk[] {
  if (!cache) return [];
  const settled: SettledAsk[] = [];
  for (const askId of askIds) {
    const entry = cache.asks[askId];
    // Absent means the producer never looked this ask up — a DIFFERENT fact from
    // `{found:false}` (looked up, not in the database), and neither is a settlement.
    if (!entry || entry.found !== true) continue;
    // `entry.open` is the producer's precomputed verdict — the single source of the
    // open/settled policy. See the NOTE at the top of this file.
    if (entry.open) continue;

    const answered = Boolean(entry.respondedAt) || entry.state === "responded";
    const marker = `${entry.state}:${entry.respondedAt ?? ""}:${entry.chosen ?? ""}`;
    if (alreadyInjected[askId] === marker) continue;
    // Cross-seam dedupe (mt#4476). The tool-call seam already put this answer in
    // front of the filing conversation mid-turn, so announcing it again at the next
    // prompt is a duplicate. Deliberately checked AFTER the local watermark and
    // BEFORE the push, so a wake-delivered ask is skipped without being recorded in
    // this hook's own watermark.
    //
    // CORRECTED mt#4517. This comment used to end: "if the two seams ever diverge (a
    // wake drained by a DIFFERENT conversation than the one this hook runs in), the
    // local watermark is still unset and the next prompt can still announce it here."
    // That escape hatch never existed. `wakeDeliveredAt` derives from
    // `max(drained_at)`, a permanent fact that reappears in every cockpit sweep, so
    // this `continue` fires on every subsequent prompt too — the ask is suppressed
    // forever, not deferred to a later one. Two things now make the premise sound
    // rather than the sentence reassuring: `drained_at` is set only for payloads the
    // agent actually RENDERED (the claim/release split in
    // `wake-pending-repository.ts`), and the cache's subquery counts only
    // CONVERSATION-keyed rows, so a session-keyed delivery no longer suppresses this
    // seam. Suppression here now means "a conversation saw it", which is the only
    // thing that makes announcing it again a duplicate.
    if (entry.wakeDeliveredAt) continue;

    settled.push({
      askId,
      state: entry.state,
      answered,
      marker,
      ...(entry.shortId || shortIdsByAskId[askId]
        ? { shortId: entry.shortId ?? shortIdsByAskId[askId] }
        : {}),
      ...(entry.title ? { title: entry.title } : {}),
      ...(entry.chosen ? { chosen: entry.chosen } : {}),
    });
  }
  return settled;
}

/**
 * Head-truncate for display. `safeTruncate` rather than `.slice`: ask titles and
 * operator answers are free-form prose that routinely carries emoji and non-BMP
 * punctuation, and a raw slice can split a surrogate pair — emitting a lone half that
 * renders as a replacement character in the agent's context.
 *
 * The `"head"` argument is load-bearing: `safeTruncate` DEFAULTS to `"tail"`, which
 * keeps the END of the string, the opposite of what a preview needs.
 */
function truncate(text: string, max: number): string {
  return text.length > max ? `${safeTruncate(text, max, "head")}…` : text;
}

/**
 * Render the notice, or null when there is nothing to say.
 *
 * Deliberately flat and short: this competes for a shared per-turn budget, and the
 * agent needs the ask's identity, that it settled, and what was chosen — not a
 * narrative.
 */
export function formatAskResponses(settled: SettledAsk[]): string | null {
  if (settled.length === 0) return null;

  const shown = settled.slice(0, MAX_ENUMERATED_ASKS);
  const lines = shown.map((ask) => {
    const label = ask.shortId ?? ask.askId.slice(0, 8);
    const title = ask.title ? ` "${truncate(ask.title, MAX_TITLE_CHARS)}"` : "";
    if (!ask.answered) {
      return `- ${label}${title} is now ${ask.state} — it is no longer awaiting the principal.`;
    }
    const chosen = ask.chosen ? ` Chosen: ${truncate(ask.chosen, MAX_CHOSEN_RENDER_CHARS)}` : "";
    return `- ${label}${title} was ANSWERED.${chosen}`;
  });

  const elided = settled.length - shown.length;
  if (elided > 0) lines.push(`- …and ${elided} more (\`asks_list\` for the rest).`);

  // Both closers are kept under the 73-char budget the worst-case derivation above
  // assumes; lengthening either one invalidates the registry's declared size.
  //
  // Derived from `settled`, NOT `shown` (PR #3257 R1): the header counts every settled
  // ask, so basing the closer on the enumerated subset lets an ANSWERED ask sit in the
  // elided tail while the closer says only "do not describe these as still awaiting the
  // principal" — dropping the instruction to go read the response, for a response that
  // exists. The closer must describe the same set the header counts.
  const anyAnswered = settled.some((a) => a.answered);
  const closer = anyAnswered
    ? "Read the response before continuing; do not describe these as still open."
    : "Do not describe these as still awaiting the principal.";

  return `Ask update: ${settled.length} ask(s) you filed have settled since the last notice.\n${lines.join("\n")}\n${closer}`;
}

/** Read the dedupe watermark: askId -> the marker last announced. */
export function readInjectionWatermark(
  watermarkPath: string = getInjectionWatermarkPath()
): Record<string, string> {
  const parsed = readJson(watermarkPath);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [askId, marker] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof marker === "string") out[askId] = marker;
  }
  return out;
}

/**
 * Record the announced markers. Best-effort: a failed write means the notice repeats
 * next turn, which is noisy but not wrong — strictly the safer direction to fail in
 * than silently swallowing an answer.
 */
export function writeInjectionWatermark(
  markers: Record<string, string>,
  watermarkPath: string = getInjectionWatermarkPath()
): boolean {
  try {
    fs.mkdirSync(path.dirname(watermarkPath), { recursive: true });
    const tempPath = `${watermarkPath}.tmp-${process.pid}`;
    fs.writeFileSync(tempPath, `${JSON.stringify(markers, null, 2)}\n`, "utf-8");
    fs.renameSync(tempPath, watermarkPath);
    return true;
  } catch {
    // intentional-swallow: see the docblock — a failed watermark write costs a repeat
    // notice, never a lost one, and must not fail the turn.
    return false;
  }
}

/** Whether `MINSKY_HOOK_OVERRIDE` disables this hook. */
export function isOverridden(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env["MINSKY_HOOK_OVERRIDE"];
  if (!raw) return false;
  return raw
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .some((name) => name === "all" || name === GUARD_NAME);
}

/**
 * Dispatcher-compatible pure-ish function (ADR-028 Phase 2b). Returns a `GuardOutcome`
 * rather than writing to stdout; the watermark write is this guard's one side effect
 * and is what makes the notice fire once per response (SC3).
 *
 * @see .minsky/hooks/registry-prompt-injection-guards.ts — the registration
 */
export function run(input: ClaudeHookInput, _ctx?: DispatchContext): GuardOutcome | null {
  if (isOverridden()) {
    return {
      auditLines: [
        `[inject-ask-responses] override active: MINSKY_HOOK_OVERRIDE names ${GUARD_NAME} at ${new Date().toISOString()}\n`,
      ],
    };
  }
  if (input.hook_event_name !== "UserPromptSubmit") return null;

  const conversationId = input.session_id;
  if (typeof conversationId !== "string" || conversationId.length === 0) return null;

  const map = readAskConversationMap();
  const askIds = askIdsForConversation(map, conversationId);
  if (askIds.length === 0) return null;

  const shortIdsByAskId: Record<string, string | undefined> = {};
  for (const askId of askIds) shortIdsByAskId[askId] = map.entries[askId]?.shortId;

  const cache = coerceCacheRecord(readJson(getAskStateCachePath()));
  const watermark = readInjectionWatermark();
  const settled = selectSettledAsks(askIds, cache, watermark, shortIdsByAskId);

  const additionalContext = formatAskResponses(settled);
  if (additionalContext === null) return null;

  const nextWatermark = { ...watermark };
  for (const ask of settled) nextWatermark[ask.askId] = ask.marker;
  // Prune watermark keys the map no longer knows about, so this file ages out with the
  // attribution map rather than growing forever.
  for (const askId of Object.keys(nextWatermark)) {
    if (!map.entries[askId]) delete nextWatermark[askId];
  }
  writeInjectionWatermark(nextWatermark);

  return { additionalContext };
}

async function main(): Promise<void> {
  let outcome: GuardOutcome | null = null;
  try {
    const input = (await readInput()) as ClaudeHookInput;
    outcome = run(input);
  } catch (err) {
    process.stderr.write(
      `[inject-ask-responses] warn: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(0);
  }

  if (outcome?.auditLines) for (const line of outcome.auditLines) process.stdout.write(line);
  if (outcome?.additionalContext) {
    const output: HookOutput = {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: outcome.additionalContext,
      },
    };
    writeOutput(output);
  }
  process.exit(0);
}

if (import.meta.main) {
  void main();
}
