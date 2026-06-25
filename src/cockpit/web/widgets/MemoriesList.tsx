import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useState } from "react";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";
import { cn } from "../lib/utils";
import type { MemoryRecord, MemoryType, MemoryScope } from "@minsky/domain/memory/types";
import { WidgetShell, type WidgetVariant } from "../components/WidgetShell";

interface MemoriesListPayload {
  records: MemoryRecord[];
  total: number;
}

interface MemoriesListProps {
  onRowClick?: (record: MemoryRecord) => void;
  /** Render-context variant; defaults to the home-grid card frame. */
  variant?: WidgetVariant;
  /** Title from the registry; defaults to the widget's canonical title for back-compat. */
  title?: string;
}

// ---------------------------------------------------------------------------
// Type badge
// ---------------------------------------------------------------------------

const TYPE_BADGE: Record<MemoryType, string> = {
  user: "bg-primary/20 text-primary",
  feedback: "bg-amber-500/20 text-amber-500",
  project: "bg-emerald-500/20 text-emerald-500",
  reference: "bg-muted text-muted-foreground",
};

function TypeBadge({ type }: { type: MemoryType }) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 rounded text-xs capitalize",
        TYPE_BADGE[type]
      )}
    >
      {type}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Relative time
// ---------------------------------------------------------------------------

function relativeTime(date: Date | string): string {
  const d = date instanceof Date ? date : new Date(date);
  const diffMs = Date.now() - d.getTime();
  if (isNaN(diffMs)) return "—";
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// Filter controls
// ---------------------------------------------------------------------------

const TYPE_OPTIONS = ["", "user", "feedback", "project", "reference"] as const;
const SCOPE_OPTIONS = ["", "project", "user", "cross_project"] as const;

interface FilterState {
  type: MemoryType | "";
  scope: MemoryScope | "";
  tagFilter: string;
  excludeSuperseded: boolean;
}

function FilterBar({
  filter,
  onChange,
}: {
  filter: FilterState;
  onChange: (f: FilterState) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <select
        value={filter.type}
        onChange={(e) => onChange({ ...filter, type: e.target.value as MemoryType | "" })}
        className="h-6 rounded border border-border bg-background px-1.5 text-xs text-foreground"
        aria-label="Filter by type"
      >
        <option value="">All types</option>
        {TYPE_OPTIONS.filter(Boolean).map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>

      <select
        value={filter.scope}
        onChange={(e) => onChange({ ...filter, scope: e.target.value as MemoryScope | "" })}
        className="h-6 rounded border border-border bg-background px-1.5 text-xs text-foreground"
        aria-label="Filter by scope"
      >
        <option value="">All scopes</option>
        {SCOPE_OPTIONS.filter(Boolean).map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>

      <input
        type="text"
        placeholder="Filter by tag…"
        value={filter.tagFilter}
        onChange={(e) => onChange({ ...filter, tagFilter: e.target.value })}
        className="h-6 rounded border border-border bg-background px-1.5 text-xs text-foreground placeholder:text-muted-foreground w-28"
        aria-label="Filter by tag"
      />

      <label className="flex items-center gap-1 text-muted-foreground cursor-pointer">
        <input
          type="checkbox"
          checked={filter.excludeSuperseded}
          onChange={(e) => onChange({ ...filter, excludeSuperseded: e.target.checked })}
          className="h-3 w-3"
        />
        Hide superseded
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chrome-agnostic body — no Card/CardHeader/CardTitle in any branch
// ---------------------------------------------------------------------------

interface MemoriesListBodyProps {
  onRowClick?: (record: MemoryRecord) => void;
  filter: FilterState;
  setFilter: (f: FilterState) => void;
  query: UseQueryResult<WidgetData, Error>;
}

function MemoriesListBody({ onRowClick, filter, setFilter, query }: MemoriesListBodyProps) {
  if (query.isLoading || !query.data) {
    return <p className="text-xs text-muted-foreground py-8 text-center">Loading…</p>;
  }

  if (query.isError || query.data.state === "degraded") {
    const reason = query.isError ? query.error.message : (query.data as { reason: string }).reason;
    return <p className="text-xs text-muted-foreground">{reason}</p>;
  }

  const payload = query.data.payload as MemoriesListPayload;

  // Client-side tag filter
  let records = payload.records;
  if (filter.tagFilter.trim()) {
    const tag = filter.tagFilter.trim().toLowerCase();
    records = records.filter((r) => r.tags.some((t) => t.toLowerCase().includes(tag)));
  }

  return (
    <>
      {/* Count + FilterBar — was in CardTitle/CardHeader area */}
      <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
        <span className="text-xs text-muted-foreground tabular-nums">
          {records.length}
          {records.length !== payload.total ? ` / ${payload.total}` : ""}
        </span>
        <FilterBar filter={filter} onChange={setFilter} />
      </div>

      {/* Table — negative margin to flush against card edges (mirrors original CardContent p-0) */}
      {records.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-8 px-4">
          No memories match the current filters.
        </p>
      ) : (
        <div className="overflow-x-auto -mx-6">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="px-3 py-2 font-medium text-muted-foreground">Type</th>
                <th className="px-3 py-2 font-medium text-muted-foreground">Name</th>
                <th className="px-3 py-2 font-medium text-muted-foreground hidden sm:table-cell">
                  Description
                </th>
                <th className="px-3 py-2 font-medium text-muted-foreground hidden md:table-cell">
                  Scope
                </th>
                <th className="px-3 py-2 font-medium text-muted-foreground hidden lg:table-cell">
                  Tags
                </th>
                <th className="px-3 py-2 font-medium text-muted-foreground text-right hidden md:table-cell">
                  Accesses
                </th>
                <th className="px-3 py-2 font-medium text-muted-foreground text-right">Created</th>
              </tr>
            </thead>
            <tbody>
              {records.map((rec) => (
                <tr
                  key={rec.id}
                  onClick={() => onRowClick?.(rec)}
                  className={cn(
                    "border-b border-border/50 last:border-0",
                    onRowClick && "cursor-pointer hover:bg-muted/40 transition-colors",
                    rec.supersededBy && "opacity-50"
                  )}
                  tabIndex={onRowClick ? 0 : undefined}
                  onKeyDown={(e) => {
                    if (onRowClick && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      onRowClick(rec);
                    }
                  }}
                  role={onRowClick ? "button" : undefined}
                  aria-label={onRowClick ? `View details for ${rec.name}` : undefined}
                >
                  <td className="px-3 py-1.5">
                    <TypeBadge type={rec.type} />
                  </td>
                  <td className="px-3 py-1.5 font-medium max-w-[160px]">
                    <span className="truncate block" title={rec.name}>
                      {rec.name}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground max-w-[220px] hidden sm:table-cell">
                    {/* Plain text (not <Prose>): truncated single-line row — block Markdown breaks layout. mt#2556 */}
                    <span className="truncate block" title={rec.description}>
                      {rec.description}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground hidden md:table-cell">
                    {rec.scope}
                  </td>
                  <td className="px-3 py-1.5 hidden lg:table-cell">
                    <div className="flex flex-wrap gap-0.5">
                      {rec.tags.slice(0, 3).map((tag) => (
                        <span
                          key={tag}
                          className="px-1 py-0.5 rounded bg-muted text-muted-foreground text-[10px]"
                        >
                          {tag}
                        </span>
                      ))}
                      {rec.tags.length > 3 && (
                        <span className="text-muted-foreground text-[10px]">
                          +{rec.tags.length - 3}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground hidden md:table-cell">
                    {rec.accessCount > 0 ? rec.accessCount : "—"}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                    {relativeTime(rec.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main widget export (mt#2373)
// ---------------------------------------------------------------------------

export function MemoriesList({
  onRowClick,
  variant = "card",
  title = "Memories",
}: MemoriesListProps) {
  const [filter, setFilter] = useState<FilterState>({
    type: "",
    scope: "",
    tagFilter: "",
    excludeSuperseded: true,
  });

  const queryParams: Record<string, string> = {};
  if (filter.type) queryParams.type = filter.type;
  if (filter.scope) queryParams.scope = filter.scope;
  if (filter.excludeSuperseded) queryParams.excludeSuperseded = "true";

  const query = useQuery<WidgetData, Error>({
    queryKey: ["widget", "memories-list", filter.type, filter.scope, filter.excludeSuperseded],
    // Params go through fetchWidgetData's params argument — embedding them in
    // the id segment puts the "?" before "/data" and the request falls through
    // to the SPA fallback (mt#2443).
    queryFn: () => fetchWidgetData("memories-list", queryParams),
    staleTime: 25_000,
    refetchInterval: 30_000,
  });

  return (
    <WidgetShell variant={variant} title={title}>
      <MemoriesListBody
        onRowClick={onRowClick}
        filter={filter}
        setFilter={setFilter}
        query={query}
      />
    </WidgetShell>
  );
}
