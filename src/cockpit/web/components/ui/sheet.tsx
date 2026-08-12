/**
 * sheet — side-anchored panel primitive (mt#3694).
 *
 * A hand-authored thin Radix wrapper, matching the house idiom in
 * `dialog.tsx` / `popover.tsx` (`src/cockpit/CLAUDE.md` §Stack: primitives are
 * hand-authored, not generated). It backs the entity side peek, and differs
 * from `dialog.tsx` in two deliberate ways — both forced by what a peek is:
 *
 * ## 1. Non-modal, and therefore not focus-trapping
 *
 * `Sheet` passes `modal={false}`. Read from the installed Radix source rather
 * than assumed (`@radix-ui/react-dialog@1.1.15`): `DialogContentNonModal` sets
 * `trapFocus: false`, which `DialogContentImpl` forwards to `FocusScope` as
 * `trapped`. So a non-modal sheet does NOT trap focus.
 *
 * That is not a compromise, it is the requirement. The peek's settled model
 * lets one HELD pane sit beside a live one, and a focus trap is defined by
 * there being exactly one region to trap into — two trapping panes is not a
 * thing Radix can express, or a11y can mean. mt#3694's success criterion
 * originally said "focus is trapped while open"; that was written for a
 * single-slot peek and is incompatible with the hold gesture. Amended in the
 * spec rather than silently dropped, to: focus MOVES INTO the pane on open,
 * Esc dismisses, and focus RETURNS to the opener on close.
 *
 * The return half also comes from the same non-modal branch, which calls
 * `context.triggerRef.current?.focus()` in `onCloseAutoFocus` — so it is
 * behavior we inherit, not behavior we reimplement.
 *
 * ## 2. No overlay
 *
 * `dialog.tsx` renders `DialogOverlay` (a `bg-black/80` scrim over the whole
 * viewport). A peek renders none, because the peek's entire purpose is that
 * the underlying page keeps its place and stays usable — a scrim would dim and
 * block exactly what the operator is peeking FROM. `disableOutsidePointerEvents`
 * is likewise false on the non-modal branch, so clicks reach the page behind.
 *
 * `role="dialog"` and the accessible name are NOT set here: Radix's
 * `DismissableLayer` sets `role="dialog"` itself and wires `aria-labelledby` to
 * whatever `SheetTitle` renders, so every pane gets both by rendering a title.
 */
import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "../../lib/utils";

/** Root. Always non-modal — see the module doc for why that is not optional. */
const Sheet = ({ children, ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) => (
  <DialogPrimitive.Root modal={false} {...props}>
    {children}
  </DialogPrimitive.Root>
);
Sheet.displayName = "Sheet";

const SheetTrigger = DialogPrimitive.Trigger;

/**
 * Portal.
 *
 * `container` is forwarded deliberately: the peek host renders ONE fixed
 * positioning region and points every pane's portal at it, so several open
 * panes lay out as flex siblings in a single row. Portalling each pane to
 * `document.body` instead would leave each one to position itself absolutely
 * and recompute offsets as siblings open and close.
 */
const SheetPortal = DialogPrimitive.Portal;

const SheetClose = DialogPrimitive.Close;

const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPrimitive.Content
    ref={ref}
    className={cn(
      // Elevation by surface lightness, not shadow (`src/cockpit/CLAUDE.md`
      // §Design vocabulary, dark-first): the pane sits on `bg-popover`, a
      // lighter surface than the page's `bg-background` behind it. The single
      // `border-l` carries the edge; no scrim exists to separate them.
      "flex h-full w-full flex-col overflow-hidden border-l border-border bg-popover",
      "data-[state=open]:animate-in data-[state=closed]:animate-out",
      "data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right",
      "duration-200",
      className
    )}
    {...props}
  >
    {children}
  </DialogPrimitive.Content>
));
SheetContent.displayName = DialogPrimitive.Content.displayName;

const SheetHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex shrink-0 items-center gap-2 border-b border-border px-3 py-2",
      "bg-popover text-popover-foreground",
      className
    )}
    {...props}
  />
);
SheetHeader.displayName = "SheetHeader";

/** Scrollable body region — the pane's own scroller, independent of the page. */
const SheetBody = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("min-h-0 flex-1 overflow-auto", className)} {...props} />
);
SheetBody.displayName = "SheetBody";

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("truncate font-mono text-sm font-medium text-foreground", className)}
    {...props}
  />
));
SheetTitle.displayName = DialogPrimitive.Title.displayName;

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-xs text-muted-foreground", className)}
    {...props}
  />
));
SheetDescription.displayName = DialogPrimitive.Description.displayName;

/** Icon close button for a sheet header. */
const SheetCloseButton = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Close>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Close
    ref={ref}
    type="button"
    className={cn(
      "rounded-sm p-1 text-muted-foreground opacity-70 transition-opacity",
      "hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring",
      className
    )}
    {...props}
  >
    <X className="h-4 w-4" />
    <span className="sr-only">Close</span>
  </DialogPrimitive.Close>
));
SheetCloseButton.displayName = "SheetCloseButton";

export {
  Sheet,
  SheetTrigger,
  SheetPortal,
  SheetClose,
  SheetCloseButton,
  SheetContent,
  SheetHeader,
  SheetBody,
  SheetTitle,
  SheetDescription,
};
