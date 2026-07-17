/**
 * Decision-group + staleness helpers for the ask inbox (mt#2882).
 *
 * The agent-inbox pattern: asks that belong to the same unit of work render
 * as ONE reviewable bundle, not N micro-approvals — the direct antidote to
 * approval fatigue (rubber-stamping masquerading as oversight). Grouping is
 * RENDER-side only; producer-side hygiene (expiry, dedup-at-create) stays
 * with the ask lifecycle (mt#1034) per the mt#2882 plan decision.
 *
 * Staleness: ISA-18.2's standing-alarm discipline — items continuously open
 * beyond the burst window are their own signal, and more than a handful of
 * them means the queue (not the item) is unhealthy.
 */
import type { AskItem } from "../widgets/AskDetail";

// ---------------------------------------------------------------------------
// Staleness (standing asks)
// ---------------------------------------------------------------------------

/**
 * An ask open longer than this is STANDING — surfaced as its own signal.
 * 24h is the project's burst-detection window (decision-defaults §Thresholds).
 */
export const STANDING_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Queue budget for standing asks: ISA-18.2's standing-alarm ceiling ("fewer
 * than 5 alarms continuously active >24h"). Above this the standing COUNT
 * renders as a queue-health warning, independent of any single ask.
 */
export const STANDING_ASK_BUDGET = 5;

export function isStanding(ask: Pick<AskItem, "createdAt">, now: number = Date.now()): boolean {
  const t = new Date(ask.createdAt).getTime();
  return Number.isFinite(t) && now - t > STANDING_AGE_MS;
}

// ---------------------------------------------------------------------------
// Decision groups (unit-of-work bundles)
// ---------------------------------------------------------------------------

export interface AskGroup {
  /** Stable render key: `${kind}|${subject}`. */
  key: string;
  kind: AskItem["kind"];
  /** The shared work anchor (task/PR ref) or null for ungroupable singles. */
  subject: string | null;
  /** Members, oldest first (the order they should be worked). */
  asks: AskItem[];
  oldestCreatedAt: string;
  standingCount: number;
}

/**
 * The unit-of-work anchor for an ask: its parent task ref when present
 * (covers both `mt#N` and `gh#N` forms). Title-based inference is
 * deliberately NOT attempted — a wrong merge is worse than no merge, and
 * the observed duplicate classes (5 × gh#1761 authorizations, 2 × mt#2505
 * decisions, byte-identical retries) all share `parentTaskId`.
 */
export function askSubject(ask: Pick<AskItem, "parentTaskId">): string | null {
  return ask.parentTaskId ?? null;
}

/**
 * Group asks into decision bundles: same kind + same subject anchor. Asks
 * without a subject remain singleton groups (keyed by their own id).
 * Group order: oldest-first by the group's oldest member within the caller's
 * pre-sorted order is NOT preserved — callers sort the returned groups.
 */
export function groupAsks(asks: AskItem[], now: number = Date.now()): AskGroup[] {
  const groups = new Map<string, AskGroup>();
  for (const ask of asks) {
    const subject = askSubject(ask);
    const key = subject ? `${ask.kind}|${subject}` : `single|${ask.id}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        key,
        kind: ask.kind,
        subject,
        asks: [ask],
        oldestCreatedAt: ask.createdAt,
        standingCount: isStanding(ask, now) ? 1 : 0,
      });
    } else {
      existing.asks.push(ask);
      if (new Date(ask.createdAt) < new Date(existing.oldestCreatedAt)) {
        existing.oldestCreatedAt = ask.createdAt;
      }
      if (isStanding(ask, now)) existing.standingCount += 1;
    }
  }
  // Members oldest-first: work the accumulated debt down from the top.
  for (const g of groups.values()) {
    g.asks.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }
  return [...groups.values()];
}

/**
 * The default inline action set for an ask, mirroring AskPage's resolve
 * payload contract (mt#1147 / mt#2615): explicit options render as their own
 * buttons (lettered); optionless asks get Approve/Deny. Every set includes
 * Defer. Escalate stays on the detail page — the inline surface carries the
 * COMMON path, not every path.
 */
export interface InlineAction {
  /** Button label — the option label or Approve/Deny/Defer. */
  label: string;
  /** Action discriminator for the mutation dispatch. */
  action: "resolve" | "defer";
  /** For resolve: the option letter (A/B/…) driving payload composition. */
  optionLetter?: string;
}

export function inlineActionsFor(ask: Pick<AskItem, "options" | "kind">): InlineAction[] {
  const actions: InlineAction[] = [];
  if (ask.options && ask.options.length > 0) {
    ask.options.forEach((opt, i) => {
      actions.push({
        label: opt.label,
        action: "resolve",
        optionLetter: String.fromCharCode("A".charCodeAt(0) + i),
      });
    });
  } else {
    // Kind-aware default labels, mirroring AskDetail's optionless contract
    // exactly (PR #2027 R1): quality.review's B is "Request changes", not
    // "Deny" — the letter-to-payload mapping is shared, the WORDING is
    // per-kind.
    const bLabel = ask.kind === "quality.review" ? "Request changes" : "Deny";
    actions.push({ label: "Approve", action: "resolve", optionLetter: "A" });
    actions.push({ label: bLabel, action: "resolve", optionLetter: "B" });
  }
  actions.push({ label: "Defer", action: "defer" });
  return actions;
}
