import type { ReactNode } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import { cn } from "../lib/utils";

/**
 * Render-context variant for a widget (mt#2373).
 *
 * Widgets render a chrome-agnostic BODY; the surrounding chrome (card frame,
 * title, page section, rail row) is supplied by {@link WidgetShell} keyed on
 * the variant. This is what lets the SAME widget body render on the home-grid
 * as a card, inside a route as a page body, in a tab, or in a rail — without
 * the widget knowing or caring which. It is the Phase 0 prerequisite for the
 * ambient-cockpit shell (mt#2370) and the per-lens perspective system
 * (mt#2372): a layout cannot recompose widgets it cannot strip of their chrome.
 *
 * - `card`      — home-grid / dashboard card frame with a titled header.
 * - `compact`   — inline single-row presentation (no card, no header).
 * - `page-body` — full-route body; the title is carried as the section label,
 *                 not re-rendered (the page already has its own heading).
 * - `rail-item` — dense rail/list row: title on the left, body on the right.
 */
export type WidgetVariant = "card" | "compact" | "page-body" | "rail-item";

export interface WidgetShellProps {
  variant: WidgetVariant;
  /**
   * The widget's title, sourced from the registry (`WidgetMeta.title`) — NOT
   * hardcoded in the widget body. Used as the card/rail heading and as the
   * accessible label for the chrome-less variants.
   */
  title: string;
  children: ReactNode;
  className?: string;
}

/**
 * Supplies a widget's chrome by composition (children-over-props): the widget
 * body is passed as `children` and this shell wraps it per `variant`. Adding a
 * new presentation context means adding a variant here, never threading a new
 * boolean through every widget.
 */
export function WidgetShell({ variant, title, children, className }: WidgetShellProps) {
  switch (variant) {
    case "card":
      return (
        <Card className={className}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold">{title}</CardTitle>
          </CardHeader>
          <CardContent>{children}</CardContent>
        </Card>
      );

    case "page-body":
      return (
        <section aria-label={title} className={cn("flex flex-col gap-3", className)}>
          {children}
        </section>
      );

    case "rail-item":
      return (
        <div
          className={cn("flex items-center justify-between gap-2 px-2 py-1.5 text-sm", className)}
        >
          <span className="truncate text-muted-foreground">{title}</span>
          <div className="flex items-center gap-2">{children}</div>
        </div>
      );

    case "compact":
      return (
        <div className={cn("flex items-center gap-3", className)} aria-label={title}>
          {children}
        </div>
      );
  }
}
