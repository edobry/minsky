import { KeyRound, Activity } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { CredentialsManager } from "../widgets/Credentials";
import { BasicHealthBody } from "../widgets/BasicHealth";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";

/**
 * System receipts (mt#2881): uptime / version / widgets-loaded moved here from
 * the home page — healthy steady-state facts are drill-down material, not
 * radiator content (/product-thinking: anomaly over inventory). Self-fetching
 * wrapper around the prop-driven BasicHealth body (its app-level polling was
 * retired with the home grid).
 */
function SystemInfo() {
  const query = useQuery<WidgetData, Error>({
    queryKey: ["widget", "basic-health"],
    queryFn: () => fetchWidgetData("basic-health"),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  if (query.isError) {
    return (
      <p className="text-sm text-muted-foreground">
        Failed to load system info: {query.error.message}
      </p>
    );
  }
  if (query.isLoading || !query.data) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  return <BasicHealthBody data={query.data} />;
}

export function SettingsPage() {
  return (
    <div className="p-4 flex flex-col gap-6 max-w-3xl mx-auto w-full">
      <div>
        <h1 className="text-lg font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Manage credentials and configuration.
        </p>
      </div>

      <section aria-label="Credentials">
        <div className="rounded-lg border border-border bg-card p-5">
          <div className="flex items-center gap-2 mb-4">
            <KeyRound aria-hidden className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Credentials</h2>
          </div>
          <CredentialsManager />
        </div>
      </section>

      <section aria-label="System">
        <div className="rounded-lg border border-border bg-card p-5">
          <div className="flex items-center gap-2 mb-4">
            <Activity aria-hidden className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">System</h2>
          </div>
          <SystemInfo />
        </div>
      </section>
    </div>
  );
}
