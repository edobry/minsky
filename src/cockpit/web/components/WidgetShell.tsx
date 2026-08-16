import { useId, type ReactNode } from "react";
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
 * - `peek`      — side-peek pane body: a narrow glance column whose frame,
 *                 padding, title and scroller are all supplied by the pane.
 *
 * ## Why `peek` exists rather than reusing `page-body` (mt#4123)
 *
 * mt#3694 shipped the peek composing `page-body` and named this choice as
 * deferred. It is the wrong one, and not by a matter of taste: `page-body` is
 * defined as a body that sits inside a ROUTE, and every route that uses it
 * supplies a wrapper the pane does not have (`TaskDetailPage` wraps it in
 * `p-4 w-full max-w-4xl`, `MemoryPage` in `p-4 w-full max-w-3xl mx-auto`). A
 * body composed for a page and then rendered with the page removed from around
 * it is the single cause the five reported peek defects share.
 *
 * The member also gives the bodies a way to ASK. A pane's chrome can be fixed
 * from the outside, but page-only chrome INSIDE a body — a capped scroller, a
 * tinted card frame — cannot be, and that was the worst of the five: the task
 * spec rendered a 10,845px document into a 540px inner window with its own
 * scrollbar, inside the pane's scrollbar. A variant is how a body finds out
 * which context it is in; that is what `WidgetVariant` is FOR, which is why
 * this extends it rather than introducing a second render-context mechanism.
 */
export type WidgetVariant = "card" | "compact" | "page-body" | "rail-item" | "peek";

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
  const titleId = useId();

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

    case "peek":
      // Structurally a section like `page-body`, deliberately: the pane already
      // renders the frame, the title and the scroller, so the body's job here is
      // the same one — be content, own no chrome. The gap is one step tighter
      // because vertical space is what a glance column is short of, and it comes
      // off the same stock 4px scale (`docs/design-system.md` §3).
      //
      // No padding: `SheetBody` supplies it for every body in the pane, so
      // adding it here would double it for the ones that route through a shell.
      return (
        <section aria-label={title} className={cn("flex flex-col gap-2", className)}>
          {children}
        </section>
      );

    case "rail-item":
      return (
        <div
          role="group"
          aria-labelledby={titleId}
          className={cn("flex items-center justify-between gap-2 px-2 py-1.5 text-sm", className)}
        >
          <span id={titleId} className="truncate text-muted-foreground">
            {title}
          </span>
          <div className="flex items-center gap-2">{children}</div>
        </div>
      );

    case "compact":
      return (
        <div role="group" className={cn("flex items-center gap-3", className)} aria-label={title}>
          {children}
        </div>
      );
  }
}
