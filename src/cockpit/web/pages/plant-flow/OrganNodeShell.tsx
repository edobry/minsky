import type React from "react";
import { Handle, Position } from "@xyflow/react";

/**
 * Shared substrate for PlantFlowPage's organ node panels (mt#2598 split —
 * extracted verbatim from PlantFlowPage.tsx's "Node data types" / "Organ
 * accent CSS variable helpers" / "Base OrganNode wrapper" sections).
 *
 * Every per-tier node module (PolicyNodes, StageNodes, SupportNodes) imports
 * from here: the base node-data shape, the VSM accent color-var lookup, and
 * the shared panel chrome component.
 */

// ---------------------------------------------------------------------------
// Node data types
// ---------------------------------------------------------------------------

export interface OrganNodeData {
  organKey: string;
  label: string;
  sublabel: string;
  accentVar: string;
  children?: React.ReactNode;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Organ accent CSS variable helpers
// These match the VSM palette in index.css / tailwind.config.ts
// ---------------------------------------------------------------------------

export const ORGAN_ACCENTS = {
  s5: "var(--vsm-s5)",
  s4: "var(--vsm-s4)",
  s3: "var(--vsm-s3)",
  s2: "var(--vsm-s2)",
  s1: "var(--vsm-s1)",
  seam: "var(--vsm-seam)",
  learn: "var(--vsm-learn)",
  infra: "var(--muted-foreground)",
} as const;

// ---------------------------------------------------------------------------
// Base OrganNode wrapper
// Provides the panel shell (border, accent stripe, label, handle positions).
// Organ-specific content is rendered as children inside the data prop.
// ---------------------------------------------------------------------------

interface OrganNodeInnerProps {
  accentVar: string;
  label: string;
  sublabel: string;
  children: React.ReactNode;
  handles?: Array<{
    type: "source" | "target";
    position: Position;
    id: string;
    style?: React.CSSProperties;
  }>;
  "data-testid"?: string;
}

export function OrganNodeShell({
  accentVar,
  label,
  sublabel,
  children,
  handles,
  "data-testid": dataTestId,
}: OrganNodeInnerProps) {
  return (
    <div
      className="relative rounded-md bg-card overflow-hidden text-foreground"
      style={{
        border: `1px solid oklch(${accentVar} / 0.30)`,
        minWidth: "160px",
        boxShadow: `0 0 16px -4px oklch(${accentVar} / 0.12)`,
      }}
      data-testid={dataTestId}
    >
      {/* Accent stripe at top */}
      <div
        className="absolute top-0 left-0 right-0 h-[2px]"
        style={{ background: `oklch(${accentVar} / 0.55)` }}
        aria-hidden="true"
      />
      {/* Header */}
      <div className="flex items-baseline gap-2 px-3 pt-3 pb-1">
        <h2
          className="text-[10px] font-mono font-bold tracking-[0.12em] uppercase leading-none"
          style={{ color: `oklch(${accentVar} / 0.85)` }}
        >
          {label}
        </h2>
        {sublabel && (
          <span className="text-[9px] font-mono text-muted-foreground leading-none truncate">
            {sublabel}
          </span>
        )}
      </div>
      {/* Content */}
      <div className="px-3 pb-3">{children}</div>
      {/* Handles — invisible dots; edges use them for routing only */}
      {handles?.map((h) => (
        <Handle
          key={h.id}
          type={h.type}
          position={h.position}
          id={h.id}
          isConnectable={false}
          style={{ opacity: 0, width: 8, height: 8, ...h.style }}
        />
      ))}
    </div>
  );
}
