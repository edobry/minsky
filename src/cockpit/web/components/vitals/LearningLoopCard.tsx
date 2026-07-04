/**
 * LearningLoopCard — /vitals "learning" loop (mt#2601).
 *
 * Live: memory.created event count in the last hour (ring + primary number)
 * via useEventFrequency, matching the task spec's explicit "memory-creation
 * rate (memory.created events via /api/activity)" instruction. Sparkline is
 * the same hook's 2h bucketed trend.
 *
 * Honest gap: "recent retrospective activity" has no event source yet — no
 * `retrospective.fired` (or equivalent) system_event exists. That arrives
 * with mt#2537. Rendered as a visibly labeled placeholder rather than
 * fabricated data.
 */
import { useEventFrequency } from "../../hooks/useEventFrequency";
import { LoopCardShell } from "./LoopCardShell";
import { RingGauge } from "./RingGauge";
import { Sparkline } from "./Sparkline";

// Visual scale only — NOT an alarm/health threshold. No canon "healthy
// memory-creation rate" exists yet; bounds the ring fill for legibility.
const MEMORY_RATE_VISUAL_SCALE = 10;

const ONE_HOUR_MS = 60 * 60 * 1000;

export function LearningLoopCard() {
  const { data: frequency, isError } = useEventFrequency("memory.created", {
    windowMs: ONE_HOUR_MS,
    bucketCount: 12, // 5-minute buckets across the last hour
  });

  const lastHourCount = frequency ? frequency.buckets.reduce((a, b) => a + b, 0) : null;
  const fraction =
    lastHourCount === null ? 0 : Math.min(1, lastHourCount / MEMORY_RATE_VISUAL_SCALE);

  const statusLine = isError
    ? "Memory rate: unavailable"
    : frequency === undefined
      ? "Loading…"
      : // mt#2537: retrospective.fired event does not exist yet — honest gap,
        // not a fabricated "0 retrospectives" claim.
        "Retrospective activity: not yet tracked (mt#2537)";

  return (
    <LoopCardShell
      label="Learning"
      ring={
        <RingGauge
          fraction={fraction}
          colorVar="--vsm-learn"
          valueLabel={lastHourCount === null ? "—" : String(lastHourCount)}
          ariaLabel={`Learning loop: ${lastHourCount === null ? "unknown" : lastHourCount} memories created in the last hour`}
        />
      }
      sparkline={
        <Sparkline
          data={frequency?.buckets ?? null}
          colorVar="--vsm-learn"
          ariaLabel="Learning loop recent activity"
        />
      }
      statusLine={statusLine}
    />
  );
}
