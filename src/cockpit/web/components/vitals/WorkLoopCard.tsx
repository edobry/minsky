/**
 * WorkLoopCard — /vitals "work" loop (mt#2601).
 *
 * Live: READY queue depth (ring + primary number) + IN-PROGRESS/IN-REVIEW
 * counts (status line), via useWorkLoopCounts (reuses /api/tasks, mt#2590
 * style). Sparkline: task.status_changed event arrivals over the last 2h —
 * a real (not fabricated) work-flow-activity trend, via useEventFrequency.
 */
import { useWorkLoopCounts } from "../../hooks/useWorkLoopCounts";
import { useEventFrequency } from "../../hooks/useEventFrequency";
import { LoopCardShell } from "./LoopCardShell";
import { RingGauge } from "./RingGauge";
import { Sparkline } from "./Sparkline";

// Visual scale only — NOT an alarm/health threshold. No canon "too many READY
// tasks" value exists yet; this just bounds the ring's fill so it reads as a
// meaningful arc rather than a hairline sliver at typical queue depths.
const READY_VISUAL_SCALE = 15;

export function WorkLoopCard() {
  const { data: counts, isError: countsErrored } = useWorkLoopCounts();
  const { data: frequency } = useEventFrequency("task.status_changed");

  const ready = counts?.ready ?? null;
  const fraction = ready === null ? 0 : Math.min(1, ready / READY_VISUAL_SCALE);

  const statusLine = countsErrored
    ? "Work queue: unavailable"
    : counts === undefined
      ? "Loading…"
      : `${counts.inProgress} in progress, ${counts.inReview} in review`;

  return (
    <LoopCardShell
      label="Work"
      ring={
        <RingGauge
          fraction={fraction}
          colorVar="--vsm-s1"
          valueLabel={ready === null ? "—" : String(ready)}
          ariaLabel={`Work loop: ${ready === null ? "unknown" : ready} tasks ready`}
        />
      }
      sparkline={
        <Sparkline
          data={frequency?.buckets ?? null}
          colorVar="--vsm-s1"
          ariaLabel="Work loop recent activity"
        />
      }
      statusLine={statusLine}
    />
  );
}
