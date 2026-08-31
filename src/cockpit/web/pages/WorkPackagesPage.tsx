/**
 * WorkPackagesPage — the work-package pool (/work-packages). ADR-046, mt#2911.
 *
 * Self-fetching via TanStack Query against GET /api/work-packages. Three
 * groups by lifecycle: Open (READY — claimable now), Claimed (IN-PROGRESS —
 * claimed_by visible), Drafting (TODO). Row title links to /tasks/:id — the
 * briefing IS the task spec, so the existing task-detail page renders it.
 *
 * Claim posts to /api/work-packages/:id/claim (the CAS path; a losing claim
 * comes back 409 naming the holder). "Copy launch" copies a terminal command
 * whose only variable content is the task id — id-as-transport, so the
 * corrupted-paste class (mt#2827's truncated tables) has nothing to corrupt:
 * the launched agent pulls the briefing from the substrate by id.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "../components/ui/button";
import { LoadingState } from "../components/LoadingState";
import { ErrorState } from "../components/ErrorState";

// ---------------------------------------------------------------------------
// Types + fetchers
// ---------------------------------------------------------------------------

export interface WorkPackageItem {
  id: string;
  title: string;
  status: string;
  claimedBy: string | null;
  claimedAt: string | null;
  updatedAt: string | null;
  memberCount: number;
}

interface WorkPackagesResponse {
  workPackages: WorkPackageItem[];
}

async function fetchWorkPackages(): Promise<WorkPackagesResponse> {
  const res = await fetch("/api/work-packages");
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Failed to load work packages: ${res.status}${body ? ` — ${body}` : ""}`);
  }
  return res.json() as Promise<WorkPackagesResponse>;
}

/**
 * The paste-into-a-terminal launch command. The id is the ONLY variable
 * content; the agent claims the package and dereferences the briefing itself.
 */
export function buildLaunchCommand(taskId: string): string {
  return `claude 'claim work package ${taskId} and proceed from its briefing'`;
}

/** Group a package list by lifecycle for the three sections. */
export function groupWorkPackages(items: WorkPackageItem[]): {
  open: WorkPackageItem[];
  claimed: WorkPackageItem[];
  drafting: WorkPackageItem[];
} {
  return {
    open: items.filter((p) => p.status === "READY"),
    claimed: items.filter((p) => p.status === "IN-PROGRESS"),
    drafting: items.filter((p) => p.status === "TODO"),
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function WorkPackagesPage() {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["work-packages"],
    queryFn: fetchWorkPackages,
    refetchInterval: 30_000,
  });

  const claimMutation = useMutation({
    mutationFn: async (taskId: string) => {
      const res = await fetch(`/api/work-packages/${encodeURIComponent(taskId)}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) throw new Error(body.message ?? `Claim failed: ${res.status}`);
      return body;
    },
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ["work-packages"] });
    },
    onError: (err: Error) => setActionError(err.message),
  });

  const releaseMutation = useMutation({
    mutationFn: async (taskId: string) => {
      const res = await fetch(`/api/work-packages/${encodeURIComponent(taskId)}/release`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) throw new Error(body.message ?? `Release failed: ${res.status}`);
      return body;
    },
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ["work-packages"] });
    },
    onError: (err: Error) => setActionError(err.message),
  });

  const copyLaunch = (taskId: string) => {
    void navigator.clipboard
      .writeText(buildLaunchCommand(taskId))
      .then(() => {
        setCopiedId(taskId);
        setTimeout(() => setCopiedId((cur) => (cur === taskId ? null : cur)), 2000);
      })
      .catch(() => setActionError("Could not copy to clipboard."));
  };

  if (isLoading) return <LoadingState message="Loading work packages…" variant="page" />;
  if (error) return <ErrorState message={(error as Error).message} />;

  const groups = groupWorkPackages(data?.workPackages ?? []);

  return (
    <div className="p-6 space-y-8 max-w-4xl">
      <div>
        <h1 className="text-xl font-semibold">Work packages</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Claimable bundles of tasks with an authored briefing. A package is picked up
          deliberately — claim it, then work its member tasks.
        </p>
      </div>

      {actionError && (
        <div className="text-sm text-destructive border border-destructive/40 rounded-md p-3">
          {actionError}
        </div>
      )}

      <Section title={`Open (${groups.open.length})`} empty="No packages open for claiming.">
        {groups.open.map((p) => (
          <PackageRow key={p.id} pkg={p}>
            <Button
              size="sm"
              onClick={() => claimMutation.mutate(p.id)}
              disabled={claimMutation.isPending}
            >
              Claim
            </Button>
            <Button size="sm" variant="outline" onClick={() => copyLaunch(p.id)}>
              {copiedId === p.id ? "Copied" : "Copy launch"}
            </Button>
          </PackageRow>
        ))}
      </Section>

      <Section title={`Claimed (${groups.claimed.length})`} empty="Nothing is claimed right now.">
        {groups.claimed.map((p) => (
          <PackageRow key={p.id} pkg={p}>
            <Button
              size="sm"
              variant="outline"
              onClick={() => releaseMutation.mutate(p.id)}
              disabled={releaseMutation.isPending}
            >
              Release
            </Button>
          </PackageRow>
        ))}
      </Section>

      <Section title={`Drafting (${groups.drafting.length})`} empty="No packages in drafting.">
        {groups.drafting.map((p) => (
          <PackageRow key={p.id} pkg={p} />
        ))}
      </Section>
    </div>
  );
}

function Section(props: { title: string; empty: string; children?: React.ReactNode }) {
  const hasRows = Array.isArray(props.children)
    ? props.children.length > 0
    : Boolean(props.children);
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
        {props.title}
      </h2>
      {hasRows ? (
        <div className="divide-y rounded-md border">{props.children}</div>
      ) : (
        <p className="text-sm text-muted-foreground">{props.empty}</p>
      )}
    </section>
  );
}

function PackageRow(props: { pkg: WorkPackageItem; children?: React.ReactNode }) {
  const { pkg } = props;
  return (
    <div className="flex items-center gap-3 p-3">
      <div className="flex-1 min-w-0">
        <Link
          to={`/tasks/${encodeURIComponent(pkg.id)}`}
          className="font-medium hover:underline"
          title="Open the briefing"
        >
          {pkg.id}
        </Link>
        <span className="ml-2 text-sm">{pkg.title}</span>
        <div className="text-xs text-muted-foreground mt-0.5">
          {pkg.memberCount} member task{pkg.memberCount === 1 ? "" : "s"}
          {pkg.claimedBy && (
            <>
              {" · claimed by "}
              <span className="font-mono">{pkg.claimedBy}</span>
              {pkg.claimedAt && ` at ${new Date(pkg.claimedAt).toLocaleString()}`}
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">{props.children}</div>
    </div>
  );
}
