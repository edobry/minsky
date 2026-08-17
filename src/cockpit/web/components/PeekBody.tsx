/**
 * PeekBody — maps a routable entity type to the body rendered inside a peek
 * pane (mt#3694; completed for all seven types by mt#4069).
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
 *   - **Self-fetching** (`TaskDetail`, `MemoryDetailBody`, `InterceptorDetail`):
 *     hand it an id.
 *   - **Payload-taking** (`ChangesetDetail`, `AskDetail`, `OverviewTab`): the
 *     PAGE owns the query and passes the result down, so the peek needs a thin
 *     adapter running that same query. Every such adapter below reuses the
 *     page's own fetcher AND its query key, so TanStack dedupes — peeking an
 *     entity already on screen costs no second request.
 *
 * ## Why `session` and `conversation` share one adapter
 *
 * They are two keyspaces of one widget: `WorkspaceDetailPage` and
 * `ConversationPage` are both thin wrappers around `RunDetail`, which owns the
 * fetching and the tab state. Their shared overview body is `OverviewTab`, and
 * a peek renders exactly that.
 *
 * It renders the OVERVIEW and stops there — not the tabbed `RunDetail` shell,
 * and not the transcript that shell hosts. `mem#742` assigns transcript replay
 * to deep investigation ("NOT the spine — that job is depth (transcript
 * replay), not breadth"), which is not the job a lateral-reference pane does.
 * Promoting the peek to a page is how you reach the transcript.
 */
import { useQuery } from "@tanstack/react-query";
import type { RoutableEntityType } from "../lib/entity-codec";
import { TaskDetail } from "../widgets/TaskDetail";
import { MemoryDetailBody } from "../widgets/MemoryDetail";
import { ChangesetDetail, type ChangesetDetailPayload } from "../widgets/ChangesetDetail";
import { fetchChangeset } from "../pages/ChangesetDetailPage";
import { AskDetail, fetchAskById, type AskItem } from "../widgets/AskDetail";
import {
  OverviewTab,
  fetchWorkspaceDetail,
  fetchConversationOverview,
  type RunKeySpace,
  type WorkspaceDetailPayload,
  type ConversationOverviewPayload,
} from "../widgets/RunDetail";
import { InterceptorDetail } from "../pages/InterceptorDetailPage";
import type { WorkspaceId, ConversationId } from "@minsky/domain/ids";
import { LoadingState } from "./LoadingState";
import { ErrorState } from "./ErrorState";

/**
 * Entity types that render their real detail body inside a peek.
 *
 * Exported so the coverage test can assert the split explicitly. As of mt#4069
 * this is every routable type — the test still pins the list, so ADDING a
 * routable type surfaces here rather than as a blank pane.
 */
export const PEEKABLE_WITH_BODY: readonly RoutableEntityType[] = [
  "task",
  "memory",
  "changeset",
  "ask",
  "session",
  "conversation",
  "interceptor",
];

/**
 * Runs the same query `ChangesetDetailPage` runs, then renders the same
 * component it renders. The duplicated `queryFn` is deduped by TanStack Query
 * under the shared key, so peeking a changeset already on screen costs no
 * second request.
 */
function ChangesetPeekBody({ id }: { id: string }) {
  const query = useQuery<ChangesetDetailPayload | null, Error>({
    // The page's own fetcher and key, imported rather than copied — a second
    // copy of the URL and its 404 handling is a second thing that can drift.
    queryKey: ["changeset", id],
    queryFn: () => fetchChangeset(id),
    staleTime: 30_000,
  });

  if (query.isPending) return <LoadingState message="Loading changeset…" />;
  if (query.isError) return <ErrorState message={query.error.message} />;
  if (!query.data) {
    return <p className="text-sm text-muted-foreground">Changeset {id} not found.</p>;
  }
  return <ChangesetDetail changeset={query.data} />;
}

/**
 * The ask body in read-only mode (mt#4069).
 *
 * `AskDetail`'s actionable shape needs resolve/defer/escalate mutations that
 * only `AskPage` owns, which is why this type had no adapter until mt#4091
 * added the read-only mode: rendering the actionable shape here with no-op
 * handlers would ship dead buttons, and that is worse than no body.
 *
 * `onClose` is deliberately omitted rather than passed a no-op — the pane
 * already has Esc, a close button and browser Back, so `AskDetail` renders no
 * "Back" affordance here at all.
 */
function AskPeekBody({ id }: { id: string }) {
  const query = useQuery<AskItem, Error>({
    queryKey: ["asks", id],
    queryFn: () => fetchAskById(id),
    staleTime: 30_000,
  });

  if (query.isPending) return <LoadingState message="Loading ask…" />;
  if (query.isError) return <ErrorState error={query.error} />;
  return <AskDetail ask={query.data} readOnly />;
}

/**
 * The overview body shared by `session` and `conversation` (mt#4069).
 *
 * Runs whichever of `RunDetail`'s two queries the keyspace uses — same fetchers,
 * same keys, same `staleTime`/`retry` — and hands the result to the same
 * `OverviewTab` the page's Overview tab renders. Only one query is enabled at a
 * time, which is also how `RunDetail` itself does it.
 */
function RunOverviewPeekBody({ id, keySpace }: { id: string; keySpace: RunKeySpace }) {
  const workspaceQuery = useQuery<WorkspaceDetailPayload, Error>({
    queryKey: ["workspace-detail", id],
    queryFn: () => fetchWorkspaceDetail(id as WorkspaceId),
    staleTime: 30_000,
    retry: 1,
    enabled: keySpace === "workspace",
  });

  const conversationQuery = useQuery<ConversationOverviewPayload, Error>({
    queryKey: ["conversation-overview", id],
    queryFn: () => fetchConversationOverview(id as ConversationId),
    staleTime: 30_000,
    retry: 1,
    enabled: keySpace === "conversation",
  });

  // No padding wrapper: `SheetBody` supplies the pane's gutters for every body
  // (mt#4123). This `p-3` predated that and would now double up.
  return (
    <OverviewTab
      keySpace={keySpace}
      id={id}
      workspaceData={workspaceQuery.data}
      workspaceQuery={workspaceQuery}
      conversationData={conversationQuery.data}
      conversationQuery={conversationQuery}
    />
  );
}

export function PeekBody({ type, id }: { type: RoutableEntityType; id: string }) {
  switch (type) {
    case "task":
      // `variant="peek"`, not `"page-body"` (mt#4123). `page-body` is a body
      // built to sit inside a route wrapper — `TaskDetailPage` supplies
      // `p-4 w-full max-w-4xl` around this exact component — and the pane
      // supplies no such wrapper, so composing it here rendered a page-density
      // layout with the page deleted from around it. That one composition error
      // is the shared cause of every defect mt#4123 was filed for.
      return <TaskDetail taskId={id} variant="peek" />;
    case "memory":
      return <MemoryDetailBody memoryId={id} />;
    case "changeset":
      return <ChangesetPeekBody id={id} />;
    case "ask":
      return <AskPeekBody id={id} />;
    case "session":
      return <RunOverviewPeekBody id={id} keySpace="workspace" />;
    case "conversation":
      return <RunOverviewPeekBody id={id} keySpace="conversation" />;
    case "interceptor":
      // The peek id IS the guardName — `/interceptors/:name` is keyed by it.
      // Padding comes from `SheetBody` (mt#4123), not from a wrapper here.
      return <InterceptorDetail name={id} />;
  }
}
