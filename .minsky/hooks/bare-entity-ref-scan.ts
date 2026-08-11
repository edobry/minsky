#!/usr/bin/env bun
// Pure scanner for the turn-end bare-entity-ref detector (mt#3286).
//
// Split from the guard shell deliberately: everything here is a string ->
// findings function with no fs, no clock, no env. The shell
// (`turn-end-bare-ref-scan.ts`) does the IO. That is the functional-core /
// imperative-shell split ADR-036 prescribes, and it is what lets the
// must-not-flag cases below be covered by fixtures rather than by patching.
//
// WHAT IS FLAGGED (advisory only — never blocking):
//   1. bare-short-id   — `ask#N` / `mem#N` / `ws#N` present with no
//                        minsky:// link labelling it in the SAME message.
//   2. malformed-target— a minsky://ask|memory|session link whose id segment
//                        is not a full 36-char UUID (ADR-029: the UUID is the
//                        sole deeplink target). Deterministically wrong, so no
//                        calibration gate applies.
//   3. raw-uuid-label  — a minsky:// link whose LABEL is a raw UUID fragment
//                        wearing a short-id prefix (`ask#…86ac1dbe`). A real
//                        short id is `#` followed by decimal digits only, so
//                        this is wrong by construction too.
//
// WHAT IS LOGGED BUT NOT FLAGGED: bare `mt#N` / `PR #N`, and a bare short id
// the caller's short-id map can resolve (`linkable-short-id`, mt#3960).
//
// THE FLAG SET TRACKS THE LINKIFIER'S COMPLEMENT (mt#3897). v0 had these two
// classes the other way around. `mt#2565` then shipped a display linkifier
// (`entity-linkify.ts`) that rewrites `mt#N` and `PR #N` into deeplinks as they
// are rendered — so warning about them tells the agent to hand-fix something
// already fixed downstream. Measured over ask#7639's review window: 13 of the
// 13 warnings this scanner injected were for that now-auto-linked class.
//
// THE COMPLEMENT IS COMPUTED, NOT HARD-CODED (mt#3960). Until mt#3914 the
// linkifier could not touch `ask#N` / `mem#N` / `ws#N` at all — their target is
// a UUID, which ADR-029 makes the sole legal one and which is not derivable
// from the visible label — so naming those three families WAS naming the
// complement. mt#3914 shipped the cached short-id map and the two stopped
// coinciding: a mapped id is repaired at display time exactly like `mt#N`,
// while an id minted since the last sweep (or any id with no cockpit running to
// refresh the cache) still reaches the reader bare. Measured on this guard's
// own log, 5 of the first 6 injected phrases after mt#3914 named ids the map
// already held.
//
// So the family is no longer the right unit and `scanMessage` takes the map as
// an argument: a short id the caller can resolve is LOGGED, one it cannot is
// FLAGGED. That keeps the flagged set equal to the linkifier's complement by
// construction rather than by a class list that goes stale each time the
// display path changes — which is what happened here, twice in two days.
//
// Passing no map means "resolve nothing", so every short id is flagged: the
// pre-mt#3914 behavior, and the correct degradation for an unreadable cache
// (ADR-024's "fail to Rung-1, never silent-skip" — under-linking costs a
// lookup, silence costs the finding).
//
// Both halves are operator decisions, not inferences: ask#7415 (2026-08-10)
// approved flagging the short-id families; ask#7639 (2026-08-10) retired the
// `mt#`/`PR #` warnings while explicitly keeping the two malformed-deeplink
// classes live — the linkifier cannot repair a link that is present but wrong.
//
// @see .minsky/hooks/turn-end-bare-ref-scan.ts — the guard shell
// @see docs/architecture/adr-029-* — full UUID as the sole deeplink target
// @see mem#623 — the linked-reference-actionability family (R1-R6)

import { elideMarkdownContexts } from "./pre-narration-detector";
import type { ShortIdKind, ShortIdMap } from "./entity-linkify";

/** A full 36-char canonical UUID, the only legal ask/memory/session target. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `decodeURIComponent` that returns null instead of throwing.
 *
 * This scanner runs inside a Stop hook over arbitrary assistant prose, so its
 * input includes half-written and hand-typed links. `decodeURIComponent`
 * throws a URIError on malformed percent-encoding (`%2`, a bare `%`), and an
 * uncaught throw here would take down the whole scan for the turn.
 */
function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    // intentional-swallow: a link whose id cannot be decoded simply does not
    // register as linking an entity; the caller degrades to treating the ref
    // as unlinked, which is the conservative direction for an advisory.
    return null;
  }
}

/**
 * Classes that produce advisory text.
 *
 * The organising axis is whether the display linkifier can repair the defect on
 * its own (see the header): `bare-short-id` it cannot, because the target is a
 * UUID it would have to look up; the two malformed-link classes it cannot,
 * because a link that is present but wrong is not a missing link at all.
 */
export type FlaggedKind = "bare-short-id" | "malformed-target" | "raw-uuid-label";

/**
 * Classes recorded for calibration and never rendered.
 *
 * Kept DISTINCT rather than folded into one "logged" bucket: they are logged
 * for different reasons and a review pass has to tell them apart. `bare-ref` is
 * repaired by a pure string transform, so it is auto-linked unconditionally;
 * `linkable-short-id` is repaired only because THIS message's map happened to
 * hold the id, which is a measurement of how much of the class mt#3914 absorbs
 * over time — and the input to any future decision about the class as a whole.
 */
export type LoggedKind = "bare-ref" | "linkable-short-id";

export interface ScanFinding {
  kind: FlaggedKind | LoggedKind;
  /** The reference as it appeared, e.g. "mt#3286" or "minsky://ask/fa4b942e". */
  ref: string;
  /** One-line reason, rendered into the advisory. */
  reason: string;
}

export interface ScanResult {
  /** Findings that produce advisory text (v0 enforced classes). */
  flagged: ScanFinding[];
  /** Findings recorded for calibration only — never rendered. */
  logged: ScanFinding[];
}

/**
 * Collect every `minsky://<type>/<id>` target present in the text, plus the
 * label each one carries. Operates on already-elided text so a link inside a
 * fenced block or a quoted spec excerpt is invisible here by construction.
 */
function collectLinks(elided: string): Array<{ label: string; type: string; id: string }> {
  const links: Array<{ label: string; type: string; id: string }> = [];
  const linkRe = /\[([^\]]*)\]\(minsky:\/\/([a-z]+)\/([^)\s]+)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(elided)) !== null) {
    links.push({ label: m[1] ?? "", type: (m[2] ?? "").toLowerCase(), id: m[3] ?? "" });
  }
  return links;
}

/**
 * Character ranges covered by the LABEL of each `[label](minsky://type/id)`
 * link, tagged with that link's entity type.
 *
 * Needed because a short id cannot be matched to its target the way a task id
 * can. `mt#3897` appears verbatim inside `minsky://task/mt%233897`, so the
 * bare-`mt#` check can ask "is this id linked anywhere in the message". An
 * `ask#N` target is a UUID with no trace of `N` in it, so the only thing that
 * ties `ask#7415` to `minsky://ask/639b443a-…` is that the former is the
 * LABEL of the latter — a positional fact, not a matchable one.
 *
 * Getting this wrong is not a near-miss: the correctly-linked form
 * `[ask#7415](minsky://ask/<uuid>)` still contains the literal text `ask#7415`,
 * so a scan that ignores position flags every properly-linked short id in the
 * corpus. That was harmless while this class was record-only (the v0 code says
 * as much: "we record either way and never flag, so precision here costs
 * nothing"), and stopped being harmless the moment it started flagging.
 */
function collectLinkLabelRanges(
  elided: string
): Array<{ type: string; start: number; end: number }> {
  const ranges: Array<{ type: string; start: number; end: number }> = [];
  const linkRe = /\[([^\]]*)\]\(minsky:\/\/([a-z]+)\/([^)\s]+)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(elided)) !== null) {
    const label = m[1] ?? "";
    // +1 skips the opening `[` so the range covers exactly the label text.
    const start = m.index + 1;
    ranges.push({ type: (m[2] ?? "").toLowerCase(), start, end: start + label.length });
  }
  return ranges;
}

export interface ScanOptions {
  /**
   * The short-id -> UUID map the DISPLAY path will use on this same message
   * (mt#3960). Supplied by the caller so this module stays pure; omitted means
   * "resolve nothing", which flags every short id.
   *
   * It must be the map the display path actually reads, not an equivalent one
   * built here — the whole claim being made is "the reader will see this ref as
   * a link", and only the display path's own view of the cache can support it.
   */
  shortIdMap?: ShortIdMap;
}

/**
 * Scan one assistant message for deeplink defects.
 *
 * `text` is the raw message; elision happens here so every caller inherits the
 * must-not-flag behavior for code fences, inline spans and blockquotes rather
 * than having to remember it.
 */
export function scanMessage(text: string, options: ScanOptions = {}): ScanResult {
  const elided = elideMarkdownContexts(text);
  const links = collectLinks(elided);
  const flagged: ScanFinding[] = [];
  const logged: ScanFinding[] = [];

  // --- class 2: malformed ask/memory/session targets (ADR-029) -------------
  for (const link of links) {
    if (link.type !== "ask" && link.type !== "memory" && link.type !== "session") continue;
    if (!UUID_RE.test(link.id)) {
      flagged.push({
        kind: "malformed-target",
        ref: `minsky://${link.type}/${link.id}`,
        reason: `target is not a full 36-char UUID — ADR-029 makes the UUID the sole ${link.type} deeplink target`,
      });
    }
  }

  // --- class 3: raw-UUID-fragment labels -----------------------------------
  // A legitimate short-id label is `ask#6984` — `#` then DECIMAL digits only.
  // A label whose tail is a hex run (with or without a leading elision marker)
  // is a UUID fragment dressed as a short id, which defeats the label's whole
  // purpose.
  //
  // The decimal case is tested FIRST and returns, rather than being caught by
  // an exemption after a broader pattern already matched (PR #2717 R1). A
  // pattern whose correctness depends on a later `continue` is one edit away
  // from silently over-flagging every large short id.
  for (const link of links) {
    const label = link.label.trim();
    const tail = /^(?:ask|mem|ws)#(.+)$/i.exec(label)?.[1];
    if (tail === undefined) continue;
    // Legitimate short id — any length.
    if (/^\d+$/.test(tail)) continue;
    // A UUID fragment, optionally preceded by an elision marker. Anything else
    // (a name, a word, an unrecognized shape) is left alone: this class only
    // claims the defect it can prove.
    if (!/^[.…]*[0-9a-f]{6,}$/i.test(tail)) continue;
    flagged.push({
      kind: "raw-uuid-label",
      ref: label,
      reason:
        "link label is a raw UUID fragment — use the short id (e.g. ask#6984) so the reader is not reading a UUID",
    });
  }

  // --- class 1: bare mt#N / PR #N ------------------------------------------
  const linkedTaskIds = new Set<string>();
  const linkedChangesetIds = new Set<string>();
  for (const link of links) {
    if (link.type === "task") {
      // Targets are percent-encoded: mt%233286 -> mt#3286.
      //
      // GUARDED (PR #2717 R1): decodeURIComponent THROWS on malformed
      // percent-encoding (`mt%2`, a lone `%`), and this runs inside a Stop
      // hook over arbitrary assistant prose — a message containing a
      // half-written link would take the whole scan down. A link we cannot
      // decode simply does not count as linking anything, which degrades to
      // "the ref looks bare" rather than to a crash.
      const decoded = safeDecode(link.id);
      if (decoded === null) continue;
      const num = /^mt#(\d+)$/i.exec(decoded)?.[1];
      if (num) linkedTaskIds.add(num);
    } else if (link.type === "changeset") {
      if (/^\d+$/.test(link.id)) linkedChangesetIds.add(link.id);
    }
  }

  const seenTask = new Set<string>();
  for (const m of elided.matchAll(/\bmt#(\d+)\b/gi)) {
    const num = m[1];
    if (!num || seenTask.has(num)) continue;
    seenTask.add(num);
    if (!linkedTaskIds.has(num)) {
      // Recorded, not flagged (mt#3897): `entity-linkify.ts` rewrites this into
      // a deeplink at display time, so the reader can already click it.
      logged.push({
        kind: "bare-ref",
        ref: `mt#${num}`,
        reason: "no minsky://task link in this message (auto-linked at display time)",
      });
    }
  }

  const seenPr = new Set<string>();
  // `PR #123` only — a bare `#123`, or the phrase "PR #" used generally about
  // GitHub, carries no id and must not fire.
  for (const m of elided.matchAll(/\bPR #(\d+)\b/g)) {
    const num = m[1];
    if (!num || seenPr.has(num)) continue;
    seenPr.add(num);
    if (!linkedChangesetIds.has(num)) {
      // Recorded, not flagged (mt#3897) — same reason as the task case above.
      logged.push({
        kind: "bare-ref",
        ref: `PR #${num}`,
        reason: "no minsky://changeset link in this message (auto-linked at display time)",
      });
    }
  }

  // --- flagged: bare ask#N / mem#N / ws#N (mt#3897) ------------------------
  // These are the classes the display linkifier cannot repair, so a bare one
  // genuinely costs the reader a lookup. See the header for the split.
  const labelRanges = collectLinkLabelRanges(elided);
  // Collected across ALL occurrences before deciding, so that linking the first
  // mention and writing the rest bare does not flag — the same "linked
  // somewhere in this message" semantics the mt#/PR# checks above use.
  const linkedShortIds = new Set<string>();
  const shortIdMatches: Array<{ whole: string; entityType: ShortIdKind; num: string }> = [];

  for (const m of elided.matchAll(/\b(ask|mem|ws)#(\d+)\b/gi)) {
    const whole = m[0];
    const kind = (m[1] ?? "").toLowerCase();
    const entityType: ShortIdKind = kind === "ask" ? "ask" : kind === "mem" ? "memory" : "session";
    const start = m.index ?? 0;
    const end = start + whole.length;
    const insideMatchingLabel = labelRanges.some(
      (r) => r.type === entityType && start >= r.start && end <= r.end
    );
    if (insideMatchingLabel) linkedShortIds.add(whole.toLowerCase());
    shortIdMatches.push({ whole, entityType, num: m[2] ?? "" });
  }

  const seenShort = new Set<string>();
  for (const { whole, entityType, num } of shortIdMatches) {
    const key = whole.toLowerCase();
    if (seenShort.has(key) || linkedShortIds.has(key)) continue;
    seenShort.add(key);
    // mt#3960: the display path resolves this id, so the reader gets a link and
    // there is nothing for the author to fix. Recorded rather than dropped —
    // the size of this population is how a later pass measures what mt#3914
    // absorbed, and a silently-discarded finding would make that unmeasurable.
    if (options.shortIdMap?.[entityType]?.[num] !== undefined) {
      logged.push({
        kind: "linkable-short-id",
        ref: whole,
        reason: "resolved by the short-id map (auto-linked at display time)",
      });
      continue;
    }
    flagged.push({
      kind: "bare-short-id",
      ref: whole,
      // The reason is what the reader of the advisory acts on, so it has to say
      // why THIS id is unresolvable when a sibling in the same message may not
      // be — "nothing downstream can link it" stopped being true of the class
      // when mt#3914 shipped.
      reason: `bare ${entityType} short id the display map cannot resolve — link it yourself; nothing downstream will`,
    });
  }

  return { flagged, logged };
}
