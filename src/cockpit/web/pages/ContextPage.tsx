/**
 * ContextPage — full-page route for the Context Inspector (/context).
 *
 * Gives the ContextInspector widget the full content-area width so operators
 * can see session context blocks, filter chips, and the content viewer
 * side-panel without the card-grid column constraint.
 *
 * The ContextInspector is self-fetching (TanStack Query), so this page is
 * thin — just layout + the widget.
 */
import { ContextInspector } from "../widgets/ContextInspector";

export function ContextPage() {
  return (
    <div className="p-4 max-w-5xl mx-auto w-full">
      <ContextInspector />
    </div>
  );
}
