/**
 * Timeline rendering rules for the conversation transcript (mt#3261).
 *
 * Two jobs, both pure so the whole space is unit-testable:
 *
 *  1. **Local-time formatting.** The transcript previously rendered timestamps
 *     via `toISOString().slice(11, 19)` — that is UTC, silently. An operator
 *     reading "14:22:07" on a machine four hours off UTC is reading a wrong
 *     time with no indication it is wrong, which is the falsely-confident
 *     derived-field class mt#3130 exists to eliminate.
 *  2. **Turn separators.** Day boundaries and long inter-turn gaps, which give
 *     "what happened overnight" and "it sat here for half an hour" somewhere to
 *     render.
 */

/**
 * How long a gap between consecutive turns must be before it is worth marking.
 *
 * **Grounded in measured cadence, not a round number** (per
 * `decision-defaults.mdc §Thresholds`). Basis: 36,310 consecutive inter-turn
 * gaps over 7 days of `agent_transcript_turns` (measured 2026-07-24) — p50 1s,
 * p90 27s, **p99 1436s**. This constant is that p99, so a marked gap is by
 * construction in the top 1% of gaps this corpus actually produces; marking at
 * p90 would decorate roughly one turn in ten and mean nothing.
 *
 * Deliberately NOT imported from `PRESENCE_STALL_THRESHOLD_MS`
 * (`packages/domain/src/conversation-run-state/presence.ts`) even though it is
 * the same number from the same measurement. These answer different questions —
 * "has a live conversation gone quiet long enough to stop claiming LIVE?" versus
 * "is this pause between two recorded turns worth drawing a line for?" — and
 * coupling them would make a future retune of presence staleness silently
 * change what the transcript draws dividers around. Same basis, separate knobs.
 */
export const TURN_GAP_THRESHOLD_MS = 1_436_000;

/** `HH:MM:SS` in the VIEWER's timezone. */
export function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** A day label for a divider, in the viewer's timezone (e.g. "Sun, Jul 26"). */
export function formatLocalDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** True when the two instants fall on different LOCAL calendar days. */
export function isDifferentLocalDay(aIso: string, bIso: string): boolean {
  const a = new Date(aIso);
  const b = new Date(bIso);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return false;
  return (
    a.getFullYear() !== b.getFullYear() ||
    a.getMonth() !== b.getMonth() ||
    a.getDate() !== b.getDate()
  );
}

/** Human-readable gap length; coarse, because the point is "how long roughly". */
export function formatGap(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  if (hours < 24) {
    const mins = totalMin % 60;
    return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`;
  }
  return `${Math.floor(hours / 24)}d`;
}

export type TurnSeparator = { kind: "day"; label: string } | { kind: "gap"; label: string };

/**
 * What (if anything) belongs between two consecutive turns.
 *
 * A day boundary wins over a gap: crossing midnight is the more legible framing,
 * and a same-turn-pair cannot usefully render both. `prevIso` being `undefined`
 * (the first rendered turn) yields no separator — a divider above the first turn
 * is chrome, not information.
 */
export function turnSeparator(
  prevIso: string | undefined,
  currIso: string,
  gapThresholdMs: number = TURN_GAP_THRESHOLD_MS
): TurnSeparator | null {
  if (!prevIso) return null;

  if (isDifferentLocalDay(prevIso, currIso)) {
    return { kind: "day", label: formatLocalDay(currIso) };
  }

  const prev = new Date(prevIso).getTime();
  const curr = new Date(currIso).getTime();
  if (Number.isNaN(prev) || Number.isNaN(curr)) return null;

  const gap = curr - prev;
  if (gap >= gapThresholdMs) {
    return { kind: "gap", label: formatGap(gap) };
  }

  return null;
}

/**
 * A DATED range, for a reader with no other context (mt#4024).
 *
 * The cockpit's own thread deliberately shows bare clock times per turn and
 * puts the day on a separator, which works because the operator arrived from a
 * list that already told them which run this is. Two surfaces have no such
 * approach and need the day inline: the published share page (the reader
 * clicked a URL out of a message) and the publish confirmation (the operator is
 * being asked to authorize exposure of a specific conversation, and "16:00:00"
 * does not identify one). Shared so those two cannot drift.
 */
export function formatDatedRange(
  first: string | undefined,
  last: string | undefined
): string | null {
  if (!first) return null;
  const day = formatLocalDay(first);
  const start = formatLocalTime(first);
  if (!last || last === first) return `${day}, ${start}`;
  return isDifferentLocalDay(first, last)
    ? `${day}, ${start} – ${formatLocalDay(last)}, ${formatLocalTime(last)}`
    : `${day}, ${start} – ${formatLocalTime(last)}`;
}
