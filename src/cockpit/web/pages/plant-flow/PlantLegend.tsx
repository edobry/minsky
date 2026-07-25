import { useState } from "react";
import { ORGAN_ACCENTS } from "./OrganNodeShell";

/**
 * Plant legend — the reading grammar (mt#2466 item 8), ported from the SVG
 * board's legend sidebar (mt#2598 split — extracted verbatim from
 * PlantFlowPage.tsx's "Plant legend" section). Lives in a react-flow Panel
 * in the bottom-right (the board's open corner). Collapsible; collapsed by
 * default (mt#2591 — info-on-demand default avoids crowding the S1 pipeline
 * tail when open).
 */

const LEGEND_ORGANS: Array<{ colorVar: string; label: string }> = [
  { colorVar: ORGAN_ACCENTS.s1, label: "S1 operations" },
  { colorVar: ORGAN_ACCENTS.s2, label: "S2 valves (interlocks)" },
  { colorVar: ORGAN_ACCENTS.s3, label: "S3 management + 3★" },
  { colorVar: ORGAN_ACCENTS.s4, label: "S4 future" },
  { colorVar: ORGAN_ACCENTS.s5, label: "S5 identity" },
  { colorVar: ORGAN_ACCENTS.seam, label: "attention seam" },
  { colorVar: ORGAN_ACCENTS.learn, label: "learning loop" },
];

export function PlantLegend() {
  // Collapsed by default (mt#2591): the expanded panel's bottom-right footprint
  // crowded the S1 pipeline tail (REVIEW/DONE) and the Learning Loop label at
  // narrower viewports. Collapse-by-default is the info-on-demand default the
  // ISA-101 HMI discipline recommends (mt#2466 canon) and keeps the common view
  // calm; the reading grammar stays one click away via the toggle below.
  const [open, setOpen] = useState(false);

  return (
    <div
      className="rounded-md border border-border bg-card/95 font-mono"
      data-testid="plant-legend"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-2.5 py-1.5 text-[9px] tracking-[0.12em] uppercase text-muted-foreground hover:text-foreground transition-colors w-full"
        aria-expanded={open}
        aria-label={open ? "Collapse legend" : "Expand legend"}
      >
        <span>{open ? "▾" : "▸"}</span>
        <span>legend</span>
      </button>
      {open && (
        <div className="px-2.5 pb-2.5 flex flex-col gap-2 max-w-[200px]">
          <div className="flex flex-col gap-1">
            <div className="text-[8px] tracking-[0.1em] uppercase text-muted-foreground/70">
              organs (VSM)
            </div>
            {LEGEND_ORGANS.map((o) => (
              <div key={o.label} className="flex items-center gap-1.5">
                <span
                  className="w-2 h-2 rounded-full flex-none"
                  style={{ background: `oklch(${o.colorVar} / 0.9)` }}
                  aria-hidden="true"
                />
                <span className="text-[9px] text-muted-foreground">{o.label}</span>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-0.5">
            <div className="text-[8px] tracking-[0.1em] uppercase text-muted-foreground/70">
              timescales
            </div>
            <div className="text-[9px] text-muted-foreground">
              <span className="font-bold">STABLE</span> — pipes · organs
            </div>
            <div className="text-[9px] text-muted-foreground">
              <span className="font-bold">FLUID</span> — instances as flow/level
            </div>
            <div className="text-[9px] text-muted-foreground">
              <span className="font-bold">BREATH</span> — levels, ~60s poll
            </div>
            <div className="text-[9px] text-muted-foreground">
              <span className="font-bold">SLOW</span> — plant grows valves
            </div>
          </div>
          <div className="text-[8px] text-muted-foreground/70 leading-snug">
            idle-honest: gestures fire only on real system events; breath and a
            pending ask are the only ambient cues. READY is live; — = placeholder.
          </div>
        </div>
      )}
    </div>
  );
}
