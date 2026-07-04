/**
 * AttentionLoopCard — /vitals "attention" loop (mt#2601).
 *
 * Live: open-ask count (useOpenAskCount, reused verbatim from mt#2590's
 * attention-widget-backed hook) + oldest-pending-ask age (useOldestAskAge,
 * reads /api/asks). Sparkline: ask.created arrivals over the last 2h.
 *
 * This is the loop the task spec calls out as "prominent when asks are
 * open" (success criterion 3) — VitalsPage passes `needsAttention` through
 * to the shared shell so the card gets a highlighted border while any ask
 * is pending. The ring fills toward full as pending count rises: an
 * Apple-Watch-style "close this ring" read, inverted from the calmer loops
 * (empty ring = nothing needs you).
 */
import { useOpenAskCount } from "../../hooks/useOpenAskCount";
import { useOldestAskAge } from "../../hooks/useOldestAskAge";
import { useEventFrequency } from "../../hooks/useEventFrequency";
import { formatDurationShort } from "../../lib/format-duration";
import { LoopCardShell } from "./LoopCardShell";
import { RingGauge } from "./RingGauge";
import { Sparkline } from "./Sparkline";

// Visual scale only — NOT an alarm threshold. Bounds the ring fill; any
// value >= this scale reads as "full" (maximally needs attention).
const OPEN_ASK_VISUAL_SCALE = 5;

export function AttentionLoopCard() {
  const { data: openCount, isError: countErrored } = useOpenAskCount();
  const { data: oldestAgeMs } = useOldestAskAge();
  const { data: frequency } = useEventFrequency("ask.created");

  const count = openCount ?? null;
  const fraction = count === null ? 0 : Math.min(1, count / OPEN_ASK_VISUAL_SCALE);
  const needsAttention = (count ?? 0) > 0;

  const statusLine = countErrored
    ? "Attention: unavailable"
    : count === undefined
      ? "Loading…"
      : count === 0
        ? "No open asks"
        : `Oldest pending: ${oldestAgeMs != null ? formatDurationShort(oldestAgeMs) : "—"}`;

  return (
    <LoopCardShell
      label="Attention"
      needsAttention={needsAttention}
      ring={
        <RingGauge
          fraction={fraction}
          colorVar="--vsm-seam"
          valueLabel={count === null ? "—" : String(count)}
          ariaLabel={`Attention loop: ${count === null ? "unknown" : count} open asks`}
        />
      }
      sparkline={
        <Sparkline
          data={frequency?.buckets ?? null}
          colorVar="--vsm-seam"
          ariaLabel="Attention loop recent activity"
        />
      }
      statusLine={statusLine}
    />
  );
}
