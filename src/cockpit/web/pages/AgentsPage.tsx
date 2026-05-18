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
    <div className="flex flex-col gap-4 p-4 max-w-5xl mx-auto w-full">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-foreground">Agents</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Active sessions and their liveness status
          </p>
        </div>
      </div>
      <Agents />
    </div>
  );
}
