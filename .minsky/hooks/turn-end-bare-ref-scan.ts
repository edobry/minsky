#!/usr/bin/env bun
// Stop-event guard: scan the turn's FINAL assistant message for entity refs
// the reader cannot click, and for deeplinks that are malformed by
// construction (mt#3286).
//
// Why turn-END specifically, rather than every message: the operator acts at
// the end of a turn. R3 of the linked-reference-actionability family (mem#623)
// is precisely a message where the entity WAS linked earlier in the turn and
// bare in the closing message — fully compliant with the old
// one-link-per-entity ceiling, and unusable to the person it was written for.
// The closing message is the surface under contract.
//
// Advisory-only, always: this guard injects text and never denies. It is a
// Rung-1 deterministic matcher (ADR-024), and a blocking Stop hook would turn
// any false positive into a hijacked turn.
//
// Posture is PER FINDING CLASS, and `run()`'s return paths below are the
// authority on it:
//   - `bare-short-id` / `malformed-target` / `raw-uuid-label` are LIVE. A fire
//     returns `additionalContext`, which the dispatcher MERGES into the Stop
//     event's `hookSpecificOutput` — subject to that merge's char budget, so a
//     lower-priority fragment can be dropped (named in a trailing notice,
//     never silently).
//   - `bare-ref` (`mt#N` / `PR #N`) is RECORD-ONLY. A message carrying only
//     those findings writes a calibration record and no text.
//   - `author-linked-short-id` is RECORD-ONLY (mt#4160). The short id resolves
//     to an entity the author already deeplinked by UUID in this same message,
//     so the reader can click it and there is nothing to ask for. Recorded
//     rather than dropped because the suppression is itself a population a
//     later calibration pass has to be able to rate.
//
// mt#3897 SWAPPED those two classes; the scanner's header carries the full
// rationale. In short: the display linkifier (mt#2565) now repairs `mt#N` and
// `PR #N` at render time, so warning about them was measured false 13 times out
// of 13, while the short-id families it cannot derive a target for are the ones
// still costing the reader a lookup.
//
// EXPIRY CONDITION — FIRED 2026-08-10, DISCHARGED per-finding by mt#3960.
// mt#3914 shipped the cached short-id → UUID map, so the linkifier now repairs
// `ask#N` / `mem#N` / `ws#N` — but only when the id is IN the map. An id minted
// since the last sweep, or any id at all when no cockpit is running to refresh
// the cache, still reaches the reader bare. So it is a NARROWING of the flagged
// population, not the clean auto-repair `bare-ref` got.
//
// mt#3960 applies that narrowing where it is decidable: the scan now consults
// the same map the display path will, and flags only the ids it cannot resolve.
// That needs no operator decision, because it changes no CLASS — every posture
// here is exactly what ask#7415 and ask#7639 set, and the guard still speaks
// for the case that actually reaches the reader bare. Measured on this guard's
// own log, the ids the map already held were 5 of the first 6 injected phrases
// after mt#3914.
//
// What remains an operator decision is retiring the `bare-short-id` class
// OUTRIGHT, which mt#3947 holds the data for. Do not read this narrowing as
// having settled that: the residue it leaves — a just-minted id cited in the
// same turn — is the shape the class exists for, and mem#623's family is a
// record of that shape costing the principal real lookups.
//
// Neither class is gated on the other — whichever fires, a calibration record
// is written, and that log is what a `/calibration-review` pass rates. The one
// path writing NO record is the override branch at the top of `run()`, which
// returns an audit line and nothing else. Flagged and log-only findings go
// into separate fields so a pass can compare the two populations.
//
// Scan input: the Stop payload's `last_assistant_message`, falling back to the
// transcript's final turn — hooks.md documents that the transcript is not
// guaranteed to carry the final message at Stop time.
//
// @see .minsky/hooks/bare-entity-ref-scan.ts — the pure scanner this shells
// @see .minsky/hooks/turn-end-retro-scan.ts — sibling Stop leg, same shape
// @see mem#623 — the R1-R6 recurrence family this detector exists to close
// @see mt#3459 — the display-surface linkifier decision; until that ships the
//      authoring burden is real and unenforced, which is what this measures

import { readFileSync } from "node:fs";

import type { ClaudeHookInput } from "./types";
import { GUARD_REGISTRY, type DispatchContext, type GuardOutcome } from "./registry";
import { calibrationLogPath } from "./dispatcher";
import { CAPTURE_SCHEMA_VERSION, captureArtifact } from "./judged-input-capture";
import { collectShortIdBindings, extractAssistantText, extractFinalTurn } from "./transcript";
import {
  partitionAuthorLinkedShortIds,
  scanMessage,
  shortIdsNeedingResolution,
  type ScanFinding,
} from "./bare-entity-ref-scan";
import { readShortIdMap } from "./linkify-message-display";

export const OVERRIDE_ENV_VAR = "MINSKY_ACK_BARE_ENTITY_REF";

export const GUARD_NAME = "turn-end-bare-ref-scan";

/**
 * Ceiling for this guard's advisory text, READ from its own registry
 * declaration rather than duplicated as a literal (PR #2717 R1).
 *
 * mt#3824's R1 finding on a sibling detector was exactly this duplication, and
 * the answer there was a comment plus a test asserting the two agree. A
 * derived value is strictly better: there is only one number, so there is
 * nothing to drift and the test becomes a receipt rather than the only thing
 * standing between the code and a stale literal.
 *
 * Safe against an import cycle: `registry.ts` reaches guard modules only
 * through `module: () => import(...)`, a lazy dynamic import evaluated at
 * dispatch time, so a static import in this direction closes no loop at
 * module-eval time.
 *
 * The render below is bounded in CODE and not merely measured in a test: the
 * finding list is unbounded — a long closing report can name many entities —
 * so an unbounded render would grow past any declared figure without anyone
 * re-measuring.
 */
const ADVISORY_BUDGET_CHARS =
  GUARD_REGISTRY.find((r) => r.name === GUARD_NAME)?.attentionCost?.denialMessageSizeChars ?? 700;

export interface StopHookInput extends ClaudeHookInput {
  stop_hook_active?: boolean;
  last_assistant_message?: string;
}

/**
 * Render the advisory, greedily fitting findings within the byte budget and
 * summarizing the remainder as one "…and K more" line so a truncated list is
 * never mistaken for a complete one.
 */
export function formatBareRefAdvisory(
  findings: ScanFinding[],
  options: { warnNextIsCapped?: boolean } = {}
): string {
  const header =
    "[turn-end-bare-ref-scan] The closing message carries entity refs the reader cannot click (mt#3286).";
  // "AND any ref you name while doing so" is the cheap half of the mt#3860 fix:
  // the loop is fed by remedy messages that name a ref in order to explain
  // which ones they are linking. Asking for both in one pass would have
  // collapsed the originating five-turn chain into two.
  // The examples must name the classes that actually fire (mt#3897). They used
  // to show `[mt#N](…)` / `[PR #N](…)` — now record-only, since the display
  // linkifier repairs those — which would hand the agent a remedy for a defect
  // it was not being told about.
  const action =
    "Link them — and any ref you name while doing so — before ending the turn: " +
    "[ask#N](minsky://ask/<uuid>), [mem#N](minsky://memory/<uuid>). " +
    "The target is the full UUID, not the short id (ADR-029); one refs_status " +
    "call resolves it. If it genuinely cannot be resolved, leave the ref bare " +
    "and say so. The obligation is per MESSAGE; the closing message is where " +
    "the operator acts.";

  const line = (f: ScanFinding): string => `  - ${f.ref}: ${f.reason}`;

  // mt#3937: the chain cap makes the guard go SILENT on the next consecutive
  // continuation — and a silent turn is indistinguishable from a clean one, so
  // the reader gets a false all-clear about refs they genuinely cannot click.
  // The disclosure cannot ride on the capped turn itself: `run()` returns before
  // producing any text there, and attaching it would re-enter the very loop
  // mt#3860 closed. So it is PRE-EMPTIVE — carried by the last advisory that
  // still renders, one turn before the silence.
  const capNotice =
    "If you continue again without an operator turn, this check goes silent — " +
    "clear every ref now, not next message.";

  const render = (listed: string[], omitted: number): string => {
    const lines = [header, "", ...listed];
    if (omitted > 0) lines.push(`  …and ${omitted} more`);
    lines.push("", action);
    if (options.warnNextIsCapped) lines.push("", capNotice);
    return lines.join("\n");
  };

  const listed: string[] = [];
  let considered = 0;
  for (const f of findings) {
    considered += 1;
    const candidate = [...listed, line(f)];
    if (render(candidate, findings.length - considered).length > ADVISORY_BUDGET_CHARS) break;
    listed.push(line(f));
  }
  return render(listed, findings.length - listed.length);
}

/**
 * The slice of a prior calibration record this guard reads back to bound its
 * own chain (mt#3860).
 */
export interface PriorFireRecord {
  session_id?: string;
  stop_hook_active?: boolean;
  advisory_emitted?: boolean;
}

/**
 * Decide whether THIS continuation's advisory is capped — the pure half, so
 * the decision is testable without a filesystem.
 *
 * The defect (mt#3860): this guard's remedy is to write a short message linking
 * the flagged refs, and that message is itself a closing message. Explaining
 * WHICH refs you are linking, or naming an adjacent task while doing so,
 * mentions refs — and a one-line linking message has no room to link every ref
 * it must name without naming more. Measured over the guard's own log: 42% of
 * all fires are Stop-hook continuations, and the longest observed chain ran
 * three turns with no operator turn between them.
 *
 * The rule: a chain gets ONE follow-up. Fire normally on an ordinary turn; fire
 * once more on the first continuation (that one is usually a real miss — 26 of
 * 63 measured continuations named refs the previous message had not); go silent
 * from the second consecutive continuation on, because past that point the
 * guard is reacting to text it caused.
 *
 * Deliberately NOT a length or ref-density threshold. `stop_hook_active` is a
 * structural signal already present on every record, so this needs no tuned
 * number — which is what `decision-defaults.mdc §Thresholds` asks for. It is
 * also NOT a blanket continuation exemption: that would suppress the 26
 * genuine misses above, which is the case Success Criterion 2 protects.
 *
 * Only the most recent fire for this session is consulted, and only its
 * `stop_hook_active` flag. A chain is by definition consecutive — an ordinary
 * fire between two continuations breaks it, and the reader below returns on the
 * first same-session record it finds.
 *
 * **It deliberately does NOT consult `advisory_emitted`,** which an earlier
 * draft did and which its own replay test falsified: suppressing turn 3 then
 * made turn 4 look like a fresh chain, so the guard alternated
 * emit/emit/silent/emit/silent instead of stopping. That halves a chain rather
 * than bounding it. Once the chain is in continuation territory it stays
 * capped, whether or not the previous turn was itself the one suppressed.
 * `advisory_emitted` is still recorded — a calibration pass needs to see which
 * fires were silenced — it just is not an input to this decision.
 */
export function advisoryIsChainCapped(
  priorFires: PriorFireRecord[],
  sessionId: string | undefined
): boolean {
  if (!sessionId) return false;
  for (let i = priorFires.length - 1; i >= 0; i -= 1) {
    const record = priorFires[i];
    if (!record || record.session_id !== sessionId) continue;
    return record.stop_hook_active === true;
  }
  return false;
}

/** How many trailing log lines to consider — a chain is consecutive and short. */
const PRIOR_FIRE_SCAN_LINES = 200;

/**
 * Read the tail of this guard's OWN calibration log — the store it already
 * writes on every fire, so the cap needs no new state of its own.
 *
 * The path comes from `calibrationLogPath` rather than a local literal, for the
 * same reason `ADVISORY_BUDGET_CHARS` reads the registry: a duplicated
 * convention drifts silently. Static import is safe here — `dispatcher.ts`
 * reaches guard modules only through a lazy `import()` at dispatch time, so
 * this direction closes no cycle at module-eval time.
 */
function readPriorFires(): PriorFireRecord[] {
  try {
    const lines = readFileSync(calibrationLogPath("bare-entity-ref"), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .slice(-PRIOR_FIRE_SCAN_LINES);
    const records: PriorFireRecord[] = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line) as PriorFireRecord);
      } catch {
        // intentional-swallow: one malformed line must not blind the cap to the
        // rest of the tail. A partially-written trailing record is normal for an
        // append-only log read concurrently with a write.
        continue;
      }
    }
    return records;
  } catch {
    // intentional-swallow: no log yet (first fire on a fresh checkout), or it is
    // unreadable. Failing OPEN is correct for an advisory guard — the cost is
    // one extra advisory, where failing closed would silence a real finding.
    return [];
  }
}

/** Guard-dispatcher entry point (GuardModule contract). */
export async function run(
  input: StopHookInput,
  ctx: DispatchContext
): Promise<GuardOutcome | null> {
  const overrideVal = process.env[OVERRIDE_ENV_VAR];
  const isOverride =
    overrideVal === "1" ||
    overrideVal?.toLowerCase() === "true" ||
    overrideVal?.toLowerCase() === "yes";
  if (isOverride) {
    return {
      auditLines: [
        `[turn-end-bare-ref-scan] OVERRIDE: ack=${overrideVal} session=${input.session_id ?? "unknown"} ts=${new Date().toISOString()}\n`,
      ],
    };
  }

  // This guard's contract is the CLOSING message specifically, so prefer the
  // directly-supplied final message; fall back to the transcript tail only
  // when the payload did not carry it.
  const { turnLines } = extractFinalTurn(ctx.transcriptLines);
  const lastMessage = input.last_assistant_message ?? "";
  const text = lastMessage || extractAssistantText(turnLines);
  if (!text) return null;

  // mt#3960: the display path resolves a short id against this cache before the
  // reader ever sees the message, so a ref it covers is already a link and must
  // not be flagged. Read here rather than in the scanner to keep that module
  // pure; an unreadable or absent cache yields undefined, which flags every
  // short id — the pre-mt#3914 behavior, and the direction ADR-024's
  // "fail to Rung-1, never silent-skip" invariant requires.
  const scan = scanMessage(text, { shortIdMap: readShortIdMap() });
  const logged = scan.logged;

  // mt#4160: the author may have deeplinked this entity by UUID in the same
  // message, in which case the reader can already click it and the advisory
  // would be asking for a link that is present. Measured over 26 injected
  // fires, that was 16 of them — the `/handoff` closing line puts a prose title
  // in the link label and the short id in a trailing parenthetical, so the
  // label-range check below it cannot see the pairing.
  //
  // The bindings come from the TRANSCRIPT, not a lookup. See
  // `collectShortIdBindings` for why: a DB read from hook context resolves to
  // null every time, so a resolver built that way would be inert in production.
  //
  // Gated on `shortIdsNeedingResolution` so the transcript walk is skipped
  // entirely unless a candidate could actually match — on the measured traffic
  // that is a few turns a day, and every other turn pays nothing.
  const candidates = shortIdsNeedingResolution(scan.flagged, scan.linkTargets);
  const partitioned =
    candidates.length > 0
      ? partitionAuthorLinkedShortIds(
          scan.flagged,
          scan.linkTargets,
          collectShortIdBindings(ctx.transcriptLines)
        )
      : { flagged: scan.flagged, authorLinked: [] as ScanFinding[] };
  const { flagged, authorLinked } = partitioned;

  // A turn whose ONLY findings were suppressed still records — the suppression
  // is a population a later pass has to be able to rate, and returning early
  // here would make it invisible in exactly the case it fired.
  if (flagged.length === 0 && logged.length === 0 && authorLinked.length === 0) return null;

  // mt#3860: only a continuation can be capped, and only a fire that would
  // actually emit needs the check — so the log read is skipped entirely on an
  // ordinary turn and on a log-only fire.
  const chainCapped =
    input.stop_hook_active === true && flagged.length > 0
      ? advisoryIsChainCapped(readPriorFires(), input.session_id)
      : false;

  const calibration = {
    source: "live" as const,
    channel: "stop" as const,
    timestamp: new Date().toISOString(),
    session_id: input.session_id,
    stop_hook_active: input.stop_hook_active === true,
    // `matches: {family, phrase}[]` is the shared shape the sweep's fallback
    // branch already parses (the `untaken-action` precedent), so this log needs
    // no dedicated parser case and its diversity axis is distinct refs for
    // free. family = the defect class, phrase = the offending ref.
    matches: flagged.map((f) => ({ family: f.kind, phrase: f.ref })),
    // The log-only population is recorded SEPARATELY rather than folded into
    // `matches`: the carve-out's whole purpose is to let a future review
    // compare flagged-vs-logged, which is impossible once they are merged.
    logged_only: logged.map((f) => ({ family: f.kind, phrase: f.ref })),
    // mt#4160: kept out of `logged_only` for the same reason `logged_only` is
    // kept out of `matches` — a population folded into another cannot be rated
    // against it, and this one exists to be rated. `reason` carries the UUID
    // that matched, so a pass can check the suppression rather than trust it.
    author_linked: authorLinked.map((f) => ({
      family: f.kind,
      phrase: f.ref,
      reason: f.reason,
    })),
    flagged_count: flagged.length,
    logged_only_count: logged.length,
    author_linked_count: authorLinked.length,
    // mt#3860: whether the advisory was SUPPRESSED as the second consecutive
    // continuation, and whether it was actually EMITTED.
    //
    // Both are RECORDED ONLY — neither is read back. `advisoryIsChainCapped`
    // consults `stop_hook_active` alone, deliberately: an earlier draft keyed on
    // `advisory_emitted` and its replay test showed that made a suppressed turn
    // read as a fresh chain, so the guard alternated rather than stopping. These
    // fields exist so a `/calibration-review` pass can see which fires the cap
    // silenced, which is otherwise invisible in the log.
    advisory_chain_capped: chainCapped,
    advisory_emitted: flagged.length > 0 && !chainCapped,
    // mt#4161: snapshot the message these findings were judged against.
    //
    // Without it a rating pass has `matches` — it can see that `mem#1041` was
    // flagged — and nothing to decide the verdict WITH. Every question that
    // settles a fire is a question about the message: was this the FIRST
    // mention of that ref, was a UUID actually in hand, was the ref inside a
    // fence the matcher should have skipped. mt#4160's pass answered them by
    // scanning session transcripts by timestamp, which worked and is not
    // guaranteed to: transcripts age out (mt#3821 measured 12 of 959 records
    // with none left), so a future pass inherits an archaeology step that can
    // simply fail.
    //
    // WHOLE message, not a per-match window. `extractMatchContext` is the
    // cheaper sibling and is the wrong tool here — a 240-char window around the
    // ref cannot answer "was this the first mention" or "was a UUID present
    // elsewhere in the message", which are two of the three questions above.
    // `captureArtifact` is bounded (16k) and records `truncated`, so a pass
    // reading a truncated record reports partial rather than a verdict.
    //
    // `captureSchema` is a NUMBER and is read by the sweep from the record's
    // `detectorFields` passthrough, never the top level — no per-kind parse
    // branch names it, so `parseDetectorFields` routes it there for every log
    // kind (`hasCaptureMarker` in `calibration-sweep.ts`; mem#888).
    captureSchema: CAPTURE_SCHEMA_VERSION,
    judgedMessage: captureArtifact(text),
  };

  // Calibration-first (ADR-024): a record is written on every fire, but the
  // advisory is emitted only for the enforced classes. A message carrying only
  // log-only findings produces a record and no text.
  if (flagged.length === 0) return { calibration };

  // mt#3860: the chain is capped at one follow-up. The record is still written
  // — a suppressed fire is data a calibration pass needs, and dropping it would
  // make the cap invisible to the very log that measured the loop.
  if (chainCapped) return { calibration };

  // mt#3937: this fire is the pre-cap moment exactly when it is ITSELF a
  // continuation that was not capped — `advisoryIsChainCapped` keys on the
  // previous fire's `stop_hook_active`, so the next consecutive continuation
  // will see THIS record and be capped. On an ordinary turn the next
  // continuation is the first one, which is not capped, so no warning is due.
  const warnNextIsCapped = input.stop_hook_active === true && !chainCapped;

  return {
    calibration,
    additionalContext: formatBareRefAdvisory(flagged, { warnNextIsCapped }),
  };
}
