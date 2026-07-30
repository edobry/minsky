/**
 * Checkbox primitive (shadcn/ui convention, mt#3348).
 *
 * Replaces the cockpit's raw `<input type="checkbox">` controls. A native
 * checkbox keeps `appearance: auto`, so the engine paints the platform widget
 * and authored surface/border tokens are never painted — the same mechanism
 * mt#3347 verified for `<select>`. Under the tray's WKWebView that surfaced as
 * native macOS chrome inside a dark-mode-first UI.
 *
 * Wraps `@radix-ui/react-checkbox` in the same forwardRef + `cn()` +
 * data-attribute-state idiom as `components/ui/select.tsx`, and matches the
 * house focus convention (`focus-visible:ring-2`, established for the Select
 * trigger in mt#3347 R1) so a checkbox focuses like every other control.
 *
 * Radix renders a `button role="checkbox"`. A button IS a labelable element,
 * so the three call sites that wrap their input in a `<label>` keep their
 * implicit association — `checkbox.label.test.tsx` pins that, because a broken
 * implicit association fails silently.
 *
 * NOT for markdown task-list checkboxes. Those are `disabled` and purely
 * presentational; mounting an interactive control there would advertise an
 * affordance the renderer does not support. They are handled by the `input`
 * override in `components/Prose.tsx`.
 */
import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";

import { cn } from "../../lib/utils";

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "peer h-3.5 w-3.5 shrink-0 rounded-sm border border-border bg-background transition-colors",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
      "data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground",
      className
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
      {props.checked === "indeterminate" ? (
        <Minus className="h-3 w-3" aria-hidden="true" />
      ) : (
        <Check className="h-3 w-3" aria-hidden="true" />
      )}
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
