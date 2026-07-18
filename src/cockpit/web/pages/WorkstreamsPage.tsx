/**
 * WorkstreamsPage — full-page route for the Workstreams widget (/workstreams).
 *
 * Self-fetching via useWorkstreamsData (mt#2385): the altitude slice is read
 * from the `?altitude=` search param (full | rollup | actionable, default
 * full) and carried in the TanStack Query key, so switching altitudes — or
 * rendering two instances at different altitudes — never collides in cache.
 * Previously this page was prop-driven from App-level polling; the migration
 * to a query-keyed fetch is what makes the slice parameterizable (mt#2385).
 */
import { useSearchParams } from "react-router-dom";
import { Workstreams } from "../widgets/Workstreams";
import {
  parseAltitude,
  useWorkstreamsData,
  WORKSTREAM_ALTITUDES,
  type WorkstreamAltitude,
} from "../lib/use-workstreams-data";

const ALTITUDE_LABELS: Record<WorkstreamAltitude, string> = {
  full: "Full",
  rollup: "Rollup",
  actionable: "Actionable",
};

function AltitudeToggle({
  altitude,
  onChange,
}: {
  altitude: WorkstreamAltitude;
  onChange: (a: WorkstreamAltitude) => void;
}) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Altitude">
      <span className="text-eyebrow font-mono uppercase text-muted-foreground mr-1">
        Altitude:
      </span>
      {WORKSTREAM_ALTITUDES.map((a) => (
        <button
          key={a}
          onClick={() => onChange(a)}
          aria-pressed={altitude === a}
          className={`text-xs px-2 py-1 rounded border transition-colors ${
            altitude === a
              ? "border-primary bg-primary/10 text-foreground"
              : "border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground"
          }`}
        >
          {ALTITUDE_LABELS[a]}
        </button>
      ))}
    </div>
  );
}

export function WorkstreamsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const altitude = parseAltitude(searchParams.get("altitude"));
  const query = useWorkstreamsData(altitude);

  const setAltitude = (next: WorkstreamAltitude) => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        if (next === "full") {
          params.delete("altitude");
        } else {
          params.set("altitude", next);
        }
        return params;
      },
      { replace: true }
    );
  };

  return (
    <div className="p-4 max-w-5xl mx-auto w-full flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-h1 font-semibold text-foreground">Workstreams</h1>
        <AltitudeToggle altitude={altitude} onChange={setAltitude} />
      </div>

      {query.isLoading || query.data === undefined ? (
        query.isError ? (
          <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
            Failed to load workstreams: {query.error.message}
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
            Loading workstreams…
          </div>
        )
      ) : (
        // page-body variant (mt#2917 fix): this route now renders its own
        // <h1> above, so the widget must not ALSO render a nested Card +
        // CardTitle "Workstreams" — the default "card" variant was doing
        // exactly that (a redundant second "Workstreams" heading + an
        // unnecessary nested border on what is already the page's own
        // content area).
        <Workstreams data={query.data} variant="page-body" title="Workstreams" />
      )}
    </div>
  );
}
