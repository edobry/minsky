/**
 * ScrubberBar — time-range replay controls for the plant board (mt#2600).
 *
 * Presentational + local input-state only: owns the raw `since`/`until`
 * datetime-local input strings and renders the play/pause/speed/exit
 * controls. All replay LOGIC (windowing, ordering, pacing, playback
 * stepping) lives in `lib/plant-replay.ts` and is driven by PlantFlowPage —
 * this component only translates form interaction into the `ReplayWindow` /
 * `ReplaySpeed` types those pure functions expect.
 *
 * A `<input type="datetime-local">` pair (rather than a draggable timeline)
 * is a "time-range select" per the feature's design sketch: it gives exact,
 * automatable control for both unit tests and the live Playwright
 * verification (mt#2600 acceptance test scrubs to a SPECIFIC known window).
 */
import { useState } from "react";
import { REPLAY_SPEEDS, type PlantMode, type ReplaySpeed, type ReplayWindow } from "../lib/plant-replay";

export interface ScrubberBarProps {
  mode: PlantMode;
  playing: boolean;
  speed: ReplaySpeed;
  /** ISO-8601 timestamp of the most recently replayed event, or null before
   *  playback has produced one / in live mode. */
  playheadIso: string | null;
  onEnterReplay: (window: ReplayWindow) => void;
  onExitReplay: () => void;
  onPlayPause: () => void;
  onSpeedChange: (speed: ReplaySpeed) => void;
}

/** Parse a `datetime-local` input value to an ISO string, or null if empty
 *  or unparseable. `datetime-local` values carry no timezone — `Date.parse`
 *  interprets them in the browser's local zone, matching what the operator
 *  sees on screen. */
function toIsoOrNull(datetimeLocalValue: string): string | null {
  if (!datetimeLocalValue) return null;
  const ms = Date.parse(datetimeLocalValue);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export function ScrubberBar({
  mode,
  playing,
  speed,
  playheadIso,
  onEnterReplay,
  onExitReplay,
  onPlayPause,
  onSpeedChange,
}: ScrubberBarProps) {
  const [sinceInput, setSinceInput] = useState("");
  const [untilInput, setUntilInput] = useState("");

  const sinceIso = toIsoOrNull(sinceInput);
  const untilIso = toIsoOrNull(untilInput);
  const canReplay = Boolean(sinceIso && untilIso && sinceIso < untilIso);

  const controlClass =
    "bg-transparent border border-border rounded px-1 text-foreground text-[9px] font-mono";
  const buttonClass =
    "px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:hover:text-muted-foreground";

  return (
    <div
      className="rounded-md border border-border bg-card/95 font-mono px-2.5 py-1.5 flex items-center gap-2 text-[9px]"
      data-testid="scrubber-bar"
    >
      <span className="uppercase tracking-[0.12em] text-muted-foreground">replay</span>
      {mode === "live" ? (
        <>
          <label className="flex items-center gap-1 text-muted-foreground">
            since
            <input
              type="datetime-local"
              step={1}
              value={sinceInput}
              onChange={(e) => setSinceInput(e.target.value)}
              className={controlClass}
              aria-label="Replay window start"
            />
          </label>
          <label className="flex items-center gap-1 text-muted-foreground">
            until
            <input
              type="datetime-local"
              step={1}
              value={untilInput}
              onChange={(e) => setUntilInput(e.target.value)}
              className={controlClass}
              aria-label="Replay window end"
            />
          </label>
          <button
            type="button"
            disabled={!canReplay}
            onClick={() => {
              if (sinceIso && untilIso) onEnterReplay({ since: sinceIso, until: untilIso });
            }}
            className={buttonClass}
            aria-label="Enter replay"
          >
            ▸ replay
          </button>
        </>
      ) : (
        <>
          <span
            className="px-1.5 py-0.5 rounded font-bold tracking-[0.08em]"
            style={{ color: "oklch(var(--warn-amber) / 1)" }}
            data-testid="replay-indicator"
          >
            ● REPLAY
          </span>
          <span className="text-muted-foreground" data-testid="replay-playhead">
            {playheadIso ?? "—"}
          </span>
          <select
            aria-label="Replay speed"
            value={speed}
            onChange={(e) => onSpeedChange(Number(e.target.value) as ReplaySpeed)}
            className={controlClass}
          >
            {REPLAY_SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
          <button type="button" onClick={onPlayPause} className={buttonClass} aria-label={playing ? "Pause replay" : "Play replay"}>
            {playing ? "⏸ pause" : "▶ play"}
          </button>
          <button type="button" onClick={onExitReplay} className={buttonClass} aria-label="Exit replay">
            ✕ exit
          </button>
        </>
      )}
    </div>
  );
}
