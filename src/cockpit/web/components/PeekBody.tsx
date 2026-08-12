/**
 * PeekBody — maps a routable entity type to the body rendered inside a peek
 * pane (mt#3694).
 *
 * ## One renderer per entity, never a second
 *
 * The rule this file exists to hold: a peeked entity renders the SAME
 * component its full page renders. A peek that grew its own compact
 * reimplementation of a detail view would drift from the page within a release
 * or two, and the operator would be reading something subtly different from
 * what the URL they promote to shows.
 *
 * Bodies fall into two shapes, which is the thing the task spec's first survey
 * missed (it surveyed who RENDERS, not who FETCHES):
 *
 *   - **Self-fetching** (`TaskDetail`, `MemoryDetailBody`): hand it an id.
 *   - **Payload-taking** (`ChangesetDetail`, `AskDetail`,
 *     `ConversationOverviewPanel`): the PAGE owns the query and passes the
 *     result down, so the peek needs a thin adapter running that same query.
 *
 * ## Types without an adapter yet
 *
 * `ask`, `session`, `conversation` and `interceptor` render an explicit
 * open-as-page affordance rather than a body. This is deliberately NOT a
 * miniature detail view: a placeholder that pretends to be the entity is
 * exactly the divergent second renderer the rule above forbids, and it would
 * also be the kind of gap that reads as finished. Each needs its page's
 * machinery to render honestly — `AskDetail` takes resolve/defer/escalate
 * mutations, and the session / conversation / interceptor detail bodies are
 * still page-only and need extracting first. Tracked as a subtask; the
 * coverage test below pins the current split so adding an adapter is a
 * deliberate edit to a named list rather than something silently forgotten.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { RoutableEntityType } from "../lib/entity-codec";
import { entityToPath } from "../lib/entity-codec";
import { TaskDetail } from "../widgets/TaskDetail";
import { MemoryDetailBody } from "../widgets/MemoryDetail";
import { ChangesetDetail, type ChangesetDetailPayload } from "../widgets/ChangesetDetail";
import { LoadingState } from "./LoadingState";
import { ErrorState } from "./ErrorState";

/**
 * Entity types that render their real detail body inside a peek.
 *
 * Exported so the coverage test can assert the split explicitly, rather than
 * the untested remainder being invisible.
 */
export const PEEKABLE_WITH_BODY: readonly RoutableEntityType[] = ["task", "memory", "changeset"];

/**
 * Runs the same query `ChangesetDetailPage` runs, then renders the same
 * component it renders. The duplicated `queryFn` is deduped by TanStack Query
 * under the shared key, so peeking a changeset already on screen costs no
 * second request.
 */
function ChangesetPeekBody({ id }: { id: string }) {
  const query = useQuery<ChangesetDetailPayload | null, Error>({
    queryKey: ["changeset", id],
    queryFn: async () => {
      const res = await fetch(`/api/changeset/${encodeURIComponent(id)}`);
      if (res.status === 404) return null;
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Failed to load changeset: ${res.status}${body ? ` — ${body}` : ""}`);
      }
      return (await res.json()) as ChangesetDetailPayload;
    },
    staleTime: 30_000,
  });

  if (query.isPending) return <LoadingState message="Loading changeset…" />;
  if (query.isError) return <ErrorState message={query.error.message} />;
  if (!query.data) {
    return <p className="p-3 text-sm text-muted-foreground">Changeset {id} not found.</p>;
  }
  return <ChangesetDetail changeset={query.data} />;
}

/**
 * The honest stand-in for a type with no adapter yet: names the entity and
 * hands over the route. It renders no entity FIELDS at all, so there is
 * nothing here that can drift away from the page it points at.
 */
function OpenAsPageOnly({ type, id }: { type: RoutableEntityType; id: string }) {
  return (
    <div className="flex flex-col items-start gap-2 p-4">
      <p className="text-sm text-muted-foreground">
        This entity does not have a peek body yet — its detail view still lives only on its page.
      </p>
      <Link
        to={entityToPath(type, id)}
        className="text-sm text-primary underline-offset-2 hover:underline"
      >
        Open {id} as a page
      </Link>
    </div>
  );
}

export function PeekBody({ type, id }: { type: RoutableEntityType; id: string }) {
  switch (type) {
    case "task":
      return <TaskDetail taskId={id} variant="page-body" />;
    case "memory":
      return <MemoryDetailBody memoryId={id} />;
    case "changeset":
      return <ChangesetPeekBody id={id} />;
    case "ask":
    case "session":
    case "conversation":
    case "interceptor":
      return <OpenAsPageOnly type={type} id={id} />;
  }
}
