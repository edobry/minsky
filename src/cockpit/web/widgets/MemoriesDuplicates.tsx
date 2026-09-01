/**
 * Duplicate-groups view for `/memories?mem_view=duplicates` (mt#4767).
 *
 * READ-ONLY, and structurally so. This component mounts no row actions, no
 * selection checkboxes, and no bulk bar — none of mt#4766's write path is
 * imported here at all, so AT4 ("the duplicates worklist exposes no
 * destructive control anywhere in its UI") holds by construction rather than
 * by a disabled prop somebody could later flip.
 *
 * The reason is a division of ownership, not caution: mt#1619 owns the dedup
 * KEY DECISION and the cleanup. Choosing which copy survives depends on that
 * decision, and a UI offering a delete button would be answering it silently.
 * So this surfaces the population and links out.
 *
 * Rows link to the ordinary detail page, where the write actions DO live —
 * an operator who has already decided can still act, one record at a time,
 * having seen the record in full.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";
import { useProject } from "../lib/project-context";
import { relativeTime } from "../lib/format";

interface DuplicateMember {
  id: string;
  shortId: string | null;
  name: string;
  type: string;
  createdAt: string;
  lastAccessedAt: string | null;
  accessCount: number;
}

interface DuplicateGroup {
  contentHash: string;
  memberCount: number;
  preview: string;
  members: DuplicateMember[];
}

interface MemoriesDuplicatesPayload {
  groups: DuplicateGroup[];
  totalGroups: number;
  totalRedundantRows: number;
  limit: number;
}

function GroupCard({ group }: { group: DuplicateGroup }) {
  return (
    <div
      className="rounded-md border border-border bg-card"
      data-testid={`duplicate-group-${group.contentHash}`}
    >
      <div className="flex items-baseline justify-between gap-2 border-b border-border px-2.5 py-1.5">
        <span className="text-[11px] font-medium text-foreground">
          {group.memberCount} identical copies
        </span>
        <span className="font-mono text-[10px] text-muted-foreground truncate">
          {group.contentHash.slice(0, 12)}
        </span>
      </div>
      {group.preview && (
        <p className="px-2.5 pt-1.5 text-[11px] text-muted-foreground line-clamp-2">
          {group.preview}
        </p>
      )}
      <ul className="px-2.5 py-1.5 space-y-0.5">
        {group.members.map((m) => (
          <li key={m.id} className="flex items-baseline gap-2 text-xs min-w-0">
            <Link
              to={`/memory/${m.id}`}
              className="font-mono text-[11px] text-primary hover:underline flex-shrink-0"
            >
              {m.shortId ?? m.id.slice(0, 8)}
            </Link>
            <span className="truncate text-foreground min-w-0 flex-1">{m.name}</span>
            <span className="text-[10px] text-muted-foreground flex-shrink-0 tabular-nums">
              {relativeTime(m.createdAt)}
            </span>
            {/* Never-read renders as "never", not 0 — a 0 here would read as
                "read zero times recently" rather than "no read has ever been
                recorded", and which copy has been read is the one signal a
                human deduping this group would actually want. */}
            <span className="text-[10px] text-muted-foreground flex-shrink-0 tabular-nums w-16 text-right">
              {m.lastAccessedAt === null ? "never read" : `${m.accessCount}x`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MemoriesDuplicates() {
  const { queryParam: projectParam } = useProject();

  const query = useQuery<WidgetData, Error>({
    queryKey: ["widget", "memories-duplicates", projectParam?.project ?? ""],
    queryFn: () => fetchWidgetData("memories-duplicates", { ...projectParam }),
    staleTime: 30_000,
  });

  if (query.isLoading || !query.data) {
    return <div className="text-xs text-muted-foreground py-2">Grouping by content…</div>;
  }

  if (query.isError || query.data.state === "degraded") {
    const reason = query.isError
      ? query.error.message
      : (query.data as { reason: string }).reason;
    return (
      <div
        role="alert"
        data-testid="duplicates-error"
        className="rounded-md border border-warn-red/40 bg-warn-red/10 px-2.5 py-2 text-xs"
      >
        <span className="font-medium text-warn-red">Duplicates unavailable</span>
        <span className="text-muted-foreground"> — {reason}</span>
      </div>
    );
  }

  const payload = query.data.payload as MemoriesDuplicatesPayload;

  if (payload.totalGroups === 0) {
    return (
      <p className="text-xs text-muted-foreground py-2" data-testid="duplicates-empty">
        No byte-identical records in this scope.
      </p>
    );
  }

  return (
    <section data-testid="memories-duplicates" className="space-y-2">
      <div className="rounded-md border border-border bg-card/60 px-2.5 py-2 text-xs">
        <p className="text-foreground">
          <span className="font-medium tabular-nums">{payload.totalRedundantRows}</span> redundant
          records across{" "}
          <span className="font-medium tabular-nums">{payload.totalGroups}</span> groups of
          identical content.
        </p>
        {/* Says plainly that nothing here acts, and where the deciding happens.
            Without this the read-only-ness reads as an oversight. */}
        <p className="text-muted-foreground mt-1">
          This view only surfaces duplicates — it never deletes or supersedes one. The dedup key
          and the cleanup belong to <span className="font-mono">mt#1619</span>, which measured a
          narrower population using a <span className="font-mono">(name, content)</span> key; the
          content-only key here also catches renamed copies, and the difference between the two is
          an input to that decision.
        </p>
        {payload.totalGroups > payload.groups.length && (
          <p className="text-muted-foreground mt-1">
            Showing the largest {payload.groups.length} of {payload.totalGroups} groups.
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        {payload.groups.map((g) => (
          <GroupCard key={g.contentHash} group={g} />
        ))}
      </div>
    </section>
  );
}
