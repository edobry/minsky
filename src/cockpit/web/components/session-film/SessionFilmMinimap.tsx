/**
 * SessionFilmMinimap — film-strip minimap for random access on long
 * sessions (mt#3184, spec SC 6).
 */
import type { MouseEvent } from "react";

export interface SessionFilmMinimapProps {
  rowCount: number;
  playheadRowIndex: number;
  onJump: (rowIndex: number) => void;
}

export function SessionFilmMinimap({ rowCount, playheadRowIndex, onJump }: SessionFilmMinimapProps) {
  function handleClick(e: MouseEvent<HTMLDivElement>) {
    if (rowCount <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
    const target = Math.round(frac * (rowCount - 1));
    onJump(Math.max(0, Math.min(rowCount - 1, target)));
  }

  const playheadFrac = rowCount > 1 ? playheadRowIndex / (rowCount - 1) : 0;

  return (
    <div
      data-testid="session-film-minimap"
      role="slider"
      aria-label="Session film minimap"
      aria-valuemin={0}
      aria-valuemax={Math.max(0, rowCount - 1)}
      aria-valuenow={playheadRowIndex}
      tabIndex={0}
      className="relative h-6 w-full shrink-0 cursor-pointer border-t border-border bg-card"
      onClick={handleClick}
    >
      <div
        data-testid="session-film-minimap-playhead"
        className="absolute top-0 h-full w-0.5 bg-primary"
        style={{ left: `${playheadFrac * 100}%` }}
      />
    </div>
  );
}
