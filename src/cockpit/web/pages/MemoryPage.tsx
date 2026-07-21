/**
 * MemoryPage — detail view route for /memory/:id (mt#2410, mt#2398 PR2).
 *
 * URL-addressable memory detail in the entity-tab pattern. Retires the fixed
 * slide-in MemoryDetail drawer: the memory is addressed by URL, opens as a
 * tab, and lineage/similar navigation is URL navigation (each hop is a
 * history entry and retargets the same memory tab path).
 */
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { MemoryDetailBody, type MemoriesDetailPayload } from "../widgets/MemoryDetail";
import { CopyId } from "../components/CopyId";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";

export function MemoryPage() {
  const { id } = useParams<{ id: string }>();
  const memoryId = id ?? "";
  const navigate = useNavigate();

  // displayId=memory.shortId (mt#2966): shares the SAME query key as
  // MemoryDetailBody's own fetch below (["widget", "memories-detail",
  // memoryId]) — TanStack Query dedupes identical keys under one QueryClient,
  // so this does not trigger a second network request. The breadcrumb renders
  // before the fetch settles, so this falls back to the raw uuid from the URL
  // param (memoryId) while loading or for a legacy pre-backfill memory.
  const detailQuery = useQuery<WidgetData, Error>({
    queryKey: ["widget", "memories-detail", memoryId],
    queryFn: () => fetchWidgetData("memories-detail", { id: memoryId }),
    staleTime: 30_000,
    enabled: memoryId !== "",
  });
  const shortId =
    detailQuery.data?.state === "ok"
      ? (detailQuery.data.payload as MemoriesDetailPayload).record.shortId
      : undefined;

  return (
    <div className="p-4 w-full max-w-3xl mx-auto">
      {/* Breadcrumb */}
      <nav
        className="flex items-center gap-1.5 text-xs text-muted-foreground mb-3"
        aria-label="Breadcrumb"
      >
        <Link to="/memories" className="hover:text-foreground transition-colors">
          Memories
        </Link>
        <span aria-hidden="true">/</span>
        <CopyId type="memory" id={memoryId} displayId={shortId} />
      </nav>

      {memoryId ? (
        <MemoryDetailBody
          memoryId={memoryId}
          onNavigate={(nextId) => navigate(`/memory/${encodeURIComponent(nextId)}`)}
        />
      ) : (
        <p className="text-sm text-muted-foreground">No memory ID in URL.</p>
      )}
    </div>
  );
}
