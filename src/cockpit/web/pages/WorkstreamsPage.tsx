/**
 * WorkstreamsPage — full-page route for the Workstreams widget (/workstreams).
 *
 * The Workstreams widget is prop-driven (receives data from App-level polling).
 * This page renders the widget in a wider layout so the collapsible workstream
 * cards have more breathing room.
 */
import type { WidgetData } from "../lib/widget-client";
import { Workstreams } from "../widgets/Workstreams";

interface WorkstreamsPageProps {
  data: WidgetData | null;
}

export function WorkstreamsPage({ data }: WorkstreamsPageProps) {
  if (data === null) {
    return (
      <div className="p-4 max-w-5xl mx-auto w-full">
        <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          Loading workstreams…
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 max-w-5xl mx-auto w-full">
      <Workstreams data={data} />
    </div>
  );
}
