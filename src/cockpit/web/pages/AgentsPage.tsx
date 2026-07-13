/**
 * AgentsPage — full-page route for the Agents widget (/agents).
 *
 * Gives the Agents widget the full content-area width so operator can see
 * more sessions at once without the card-grid column constraint.
 *
 * The Agents widget is self-fetching (TanStack Query), so this page is
 * thin — just layout + the widget + a page heading.
 */
import { Agents } from "../widgets/Agents";

export function AgentsPage() {
  return (
    <div className="p-4 max-w-5xl mx-auto w-full">
      <Agents />
    </div>
  );
}
