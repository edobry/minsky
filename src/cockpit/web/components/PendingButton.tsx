/**
 * PendingButton — a Button that says so while its own request is in flight (mt#4503).
 *
 * Third member of the shared call-site-state family, beside `LoadingState` and
 * `ErrorState` (mt#2616). Those two cover a QUERY's loading and error branches;
 * this covers the branch neither of them reaches — the moment between an
 * operator's click and the mutation settling, where the only thing the cockpit
 * used to render was `disabled`.
 *
 * **Why `disabled` alone is not feedback.** A grayed-out control is ambiguous by
 * construction: it is the same rendering the cockpit uses for "this action is
 * unavailable to you" and for "this control is broken". The operator report this
 * component answers (2026-08-24) is exactly that ambiguity — "the option buttons
 * go gray and unclickable, which is correct, but then there's no visual
 * indication that my response is being saved ... I'm kind of looking at it,
 * wondering if anything is broken."
 *
 * **Why the label survives.** Swapping the child text for "Saving…" would make
 * an ask's option row reflow mid-click — producer-supplied option labels run
 * 40-60 chars (see `AsksPage`'s `ACTION_LABEL_MAX_W` note), so the buttons would
 * visibly resize under the pointer. The spinner is prepended instead, and the
 * words live in one `role="status"` line the acting surface renders beside the
 * row. Motion and prose, without the jump.
 *
 * **Honest-motion law** (`/cockpit-design` SKILL.md §458): every motion is driven
 * by a real event, and decorative spinners are banned because they destroy the
 * operator's ability to read the system. The spinner here renders ONLY while
 * `pending` is true, and `pending` comes from a real in-flight request — so an
 * idle cockpit is still perfectly still.
 *
 * Precedent inside this codebase: `CredentialRequestForm`'s own Save button
 * already does this (`{addMutation.isPending ? "Saving..." : "Save credential"}`,
 * mt#4030). It got the affordance right; its sibling ask controls never did.
 * This component is that pattern, extracted so a fourth surface cannot forget it.
 */
import type { ComponentProps, ReactNode } from "react";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

export interface PendingButtonProps extends ComponentProps<typeof Button> {
  /**
   * True while THIS button's own request is in flight.
   *
   * Deliberately per-button rather than "some request is in flight": the whole
   * point is telling the operator WHICH answer is being saved, so a surface with
   * several controls passes `pending` to one of them and `disabled` to the rest.
   */
  pending?: boolean;
  children?: ReactNode;
}

/**
 * The spinner itself — inline rather than a shared icon component because it has
 * exactly one caller and `components/ui/` carries no spinner today.
 *
 * `aria-hidden` because the accessible announcement is the acting surface's
 * `role="status"` line plus this button's own `aria-busy`; a third
 * screen-reader-visible element would just repeat them.
 */
function Spinner() {
  return (
    <svg
      className="h-3 w-3 shrink-0 animate-spin"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      data-testid="pending-spinner"
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path
        d="M8 1.5a6.5 6.5 0 0 1 6.5 6.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function PendingButton({
  pending = false,
  disabled,
  children,
  className,
  ...rest
}: PendingButtonProps) {
  return (
    <Button
      {...rest}
      // A pending button is disabled too — a second click would fire a second
      // mutation against an ask the first one is already closing.
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={cn("gap-1.5", className)}
    >
      {pending && <Spinner />}
      {children}
    </Button>
  );
}
