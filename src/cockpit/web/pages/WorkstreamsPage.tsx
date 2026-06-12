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
      <span className="text-xs text-muted-foreground uppercase tracking-wide mr-1">Altitude:</span>
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
      <AltitudeToggle altitude={altitude} onChange={setAltitude} />

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
        <Workstreams data={query.data} />
      )}
    </div>
  );
}
