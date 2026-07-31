/**
 * MetaItem — shared label/value cell for overview panels (dt/dd pair).
 *
 * Extracted from RunDetail.tsx (PR #1967 R1): ConversationOverviewPanel
 * imported it from RunDetail while RunDetail imported the panel — a module
 * cycle whose evaluation order could leave a binding undefined at runtime.
 * A leaf component module breaks the cycle for every consumer.
 */
import type React from "react";

export function MetaItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground uppercase tracking-wide">{label}</dt>
      <dd className="text-sm truncate">{children}</dd>
    </div>
  );
}
