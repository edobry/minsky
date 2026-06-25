/**
 * ChangesetDetailPage — detail view route for /changeset/:id (mt#2535).
 *
 * URL-addressable changeset/PR detail in the entity-tab pattern. Sibling of
 * /tasks/:id, /session/:id, /ask/:id, /memory/:id. The id parameter is the
 * changeset id — the VCS-agnostic abstraction keyed to the PR number
 * (github-pr changeset kind) as a string. Consistent with mt#1920's /changesets
 * list and ADR-008 (mt#1335) changeset abstraction.
 *
 * Durable entity convention: changeset tabs persist across actions (unlike
 * consumable asks which close on settle). The tab stays in the working set
 * until the user closes it. This follows the same convention as tasks, sessions,
 * and memories.
 *
 * Data: GET /api/changeset/:id resolves the changeset id to a session record
 * whose pullRequest.number matches, then returns { pr, session, commits }.
 * Each enrichment degrades independently — only a wholly unresolvable id is a 404.
 */
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChangesetDetail, type ChangesetDetailPayload } from "../widgets/ChangesetDetail";
import { shortenId } from "../lib/format";

async function fetchChangeset(id: string): Promise<ChangesetDetailPayload | null> {
  const res = await fetch(`/api/changeset/${encodeURIComponent(id)}`);
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Failed to load changeset: ${res.status}${body ? ` — ${body}` : ""}`);
  }
  return res.json() as Promise<ChangesetDetailPayload>;
}

export function ChangesetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const changesetId = id ?? "";

  const query = useQuery<ChangesetDetailPayload | null, Error>({
    queryKey: ["changeset", changesetId],
    queryFn: () => fetchChangeset(changesetId),
    staleTime: 30_000,
    enabled: changesetId.length > 0,
  });

  return (
    <div className="p-4 max-w-3xl mx-auto w-full">
      {/* Breadcrumb */}
      <nav
        className="flex items-center gap-1.5 text-xs text-muted-foreground mb-3"
        aria-label="Breadcrumb"
      >
        <Link to="/changesets" className="hover:text-foreground transition-colors">
          Changesets
        </Link>
        <span aria-hidden="true">/</span>
        <span className="font-mono text-foreground" title={changesetId}>
          {shortenId(changesetId)}
        </span>
      </nav>

      {query.isError ? (
        <p className="text-sm text-destructive">
          Failed to load changeset: {query.error.message}
        </p>
      ) : query.isPending ? (
        <p className="text-sm text-muted-foreground">Loading changeset…</p>
      ) : query.data ? (
        <ChangesetDetail changeset={query.data} />
      ) : (
        <div className="flex flex-col gap-1 py-8 text-center">
          <p className="text-sm text-muted-foreground">Changeset not found.</p>
          <p className="text-xs text-muted-foreground/70">
            The changeset id may be invalid, or the associated session record may have been
            removed.
          </p>
        </div>
      )}
    </div>
  );
}
