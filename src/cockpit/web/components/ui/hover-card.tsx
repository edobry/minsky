/**
 * HoverCard primitive (shadcn/ui convention, mt#3174).
 *
 * Thin wrapper around `@radix-ui/react-hover-card`, following the same
 * forwardRef + `cn()` + Tailwind animate-in/out pattern as the existing
 * `components/ui/popover.tsx`.
 *
 * IMPORTANT — accessibility constraint (mt#3165 "Hover is supplementary"):
 * Radix documents HoverCard as "intended for sighted users only" —
 * inaccessible to keyboard navigation and ignored by screen readers
 * (<https://www.radix-ui.com/primitives/docs/components/hover-card>). This
 * primitive is therefore an ADDITIVE affordance only. Any caller using it
 * MUST ensure the trigger's own inline content already identifies the
 * reference on its own — never put load-bearing information ONLY inside
 * `HoverCardContent`. See `../EntityRef.tsx` for the consuming pattern.
 */
import * as React from "react";
import * as HoverCardPrimitive from "@radix-ui/react-hover-card";

import { cn } from "../../lib/utils";

const HoverCard = HoverCardPrimitive.Root;

const HoverCardTrigger = HoverCardPrimitive.Trigger;

const HoverCardContent = React.forwardRef<
  React.ElementRef<typeof HoverCardPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof HoverCardPrimitive.Content>
>(({ className, align = "center", sideOffset = 4, ...props }, ref) => (
  <HoverCardPrimitive.Portal>
    <HoverCardPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "z-50 w-64 rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        className
      )}
      {...props}
    />
  </HoverCardPrimitive.Portal>
));
HoverCardContent.displayName = HoverCardPrimitive.Content.displayName;

export { HoverCard, HoverCardTrigger, HoverCardContent };
