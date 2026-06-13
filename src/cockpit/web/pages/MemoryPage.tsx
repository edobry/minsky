/**
 * MemoryPage — detail view route for /memory/:id (mt#2410, mt#2398 PR2).
 *
 * URL-addressable memory detail in the entity-tab pattern. Retires the fixed
 * slide-in MemoryDetail drawer: the memory is addressed by URL, opens as a
 * tab, and lineage/similar navigation is URL navigation (each hop is a
 * history entry and retargets the same memory tab path).
 */
import { useParams, useNavigate, Link } from "react-router-dom";
import { MemoryDetailBody } from "../widgets/MemoryDetail";
import { shortenId } from "../lib/format";

export function MemoryPage() {
  const { id } = useParams<{ id: string }>();
  const memoryId = id ?? "";
  const navigate = useNavigate();

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
        <span className="font-mono text-foreground" title={memoryId}>
          {shortenId(memoryId)}
        </span>
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
