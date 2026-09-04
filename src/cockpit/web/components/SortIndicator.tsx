/**
 * SortIndicator — shared sort-direction glyph (mt#4762)
 *
 * Extracted from three byte-identical copy-pasted definitions
 * (`TaskList.tsx:136`, `Agents.tsx:333`, `Workstreams.tsx:146`) once a fourth
 * copy (`MemoriesList.tsx`) was about to make it four. Renders a neutral
 * up/down glyph for an inactive sort column, or a direction-specific arrow
 * for the active one.
 */
import type { SortDir } from "../lib/useListControls";

export interface SortIndicatorProps {
  /** Whether this column is the current sort key. */
  active: boolean;
  /** Current sort direction — only meaningful (and only rendered) when `active`. */
  dir: SortDir;
}

export function SortIndicator({ active, dir }: SortIndicatorProps) {
  if (!active) {
    return <span className="text-muted-foreground opacity-30 ml-0.5">↕</span>;
  }
  return <span className="ml-0.5">{dir === "asc" ? "↑" : "↓"}</span>;
}
