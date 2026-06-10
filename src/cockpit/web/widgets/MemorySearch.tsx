import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";
import { cn } from "../lib/utils";
import type { MemoryRecord, MemoryType } from "@minsky/domain/memory/types";
import { WidgetShell, type WidgetVariant } from "../components/WidgetShell";

interface MemorySearchResult {
  record: MemoryRecord;
  score: number;
}

interface MemoriesSearchPayload {
  results: MemorySearchResult[];
  backend: "embeddings" | "lexical" | "none";
  degraded: boolean;
  query: string;
}

interface MemorySearchProps {
  onResultClick?: (record: MemoryRecord) => void;
  /** Render-context variant; defaults to the home-grid card frame. */
  variant?: WidgetVariant;
  /** Title from the registry; defaults to the widget's canonical title for back-compat. */
  title?: string;
}

const TYPE_BADGE: Record<MemoryType, string> = {
  user: "bg-primary/20 text-primary",
  feedback: "bg-amber-500/20 text-amber-500",
  project: "bg-emerald-500/20 text-emerald-500",
  reference: "bg-muted text-muted-foreground",
};

// ---------------------------------------------------------------------------
// Chrome-agnostic body — no Card/CardHeader/CardTitle in any branch
// ---------------------------------------------------------------------------

interface MemorySearchBodyProps {
  onResultClick?: (record: MemoryRecord) => void;
  inputValue: string;
  debouncedQuery: string;
  handleInput: (e: React.ChangeEvent<HTMLInputElement>) => void;
  query: ReturnType<typeof useQuery<WidgetData, Error>>;
}

function MemorySearchBody({
  onResultClick,
  inputValue,
  debouncedQuery,
  handleInput,
  query,
}: MemorySearchBodyProps) {
  const data = query.data;
  const payload = data?.state === "ok" ? (data.payload as MemoriesSearchPayload) : null;

  const showDegradedWarning = payload?.degraded || payload?.backend === "lexical";
  const backendLabel =
    payload?.backend === "embeddings"
      ? "Semantic"
      : payload?.backend === "lexical"
        ? "Lexical"
        : null;

  return (
    <div className="space-y-3">
      {/* Backend indicator — was in CardHeader alongside title */}
      {payload && debouncedQuery && (
        <div className="flex items-center gap-2 justify-end -mt-1">
          {showDegradedWarning && (
            <span className="text-xs text-amber-500">
              {payload.degraded
                ? "Embeddings degraded — lexical fallback"
                : "Lexical search active"}
            </span>
          )}
          {backendLabel && !showDegradedWarning && (
            <span className="text-xs text-muted-foreground">{backendLabel}</span>
          )}
        </div>
      )}

      {/* Search input */}
      <div className="relative">
        <input
          type="search"
          placeholder="Search memories…"
          value={inputValue}
          onChange={handleInput}
          className={cn(
            "w-full h-8 rounded border border-border bg-background px-3 text-sm",
            "placeholder:text-muted-foreground text-foreground",
            "focus:outline-none focus:ring-1 focus:ring-ring"
          )}
          aria-label="Search memories"
        />
      </div>

      {/* Degradation warning banner */}
      {showDegradedWarning && debouncedQuery && (
        <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
          {payload?.degraded
            ? "Embeddings provider is degraded or unavailable. Showing lexical fallback results — semantic similarity unavailable."
            : "Showing lexical search results. Semantic similarity unavailable."}
        </div>
      )}

      {/* Results */}
      {query.isLoading && debouncedQuery && (
        <p className="text-xs text-muted-foreground">Searching…</p>
      )}

      {!debouncedQuery && (
        <p className="text-xs text-muted-foreground">
          Type to search across all memory records.
        </p>
      )}

      {payload && debouncedQuery && !query.isLoading && (
        <>
          {payload.results.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">
              No memories match &ldquo;{debouncedQuery}&rdquo;.
            </p>
          ) : (
            <ul className="space-y-1.5 max-h-80 overflow-y-auto">
              {payload.results.map(({ record, score }) => (
                <li
                  key={record.id}
                  onClick={() => onResultClick?.(record)}
                  className={cn(
                    "rounded border border-border/60 bg-card px-3 py-2",
                    onResultClick &&
                      "cursor-pointer hover:bg-muted/40 hover:border-border transition-colors"
                  )}
                  tabIndex={onResultClick ? 0 : undefined}
                  onKeyDown={(e) => {
                    if (onResultClick && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      onResultClick(record);
                    }
                  }}
                  role={onResultClick ? "button" : undefined}
                  aria-label={onResultClick ? `View ${record.name}` : undefined}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className={cn(
                          "inline-flex items-center px-1 py-0.5 rounded text-[10px] capitalize flex-shrink-0",
                          TYPE_BADGE[record.type]
                        )}
                      >
                        {record.type}
                      </span>
                      <span className="text-xs font-medium truncate" title={record.name}>
                        {record.name}
                      </span>
                    </div>
                    {payload.backend === "embeddings" && (
                      <span className="text-[10px] text-muted-foreground tabular-nums flex-shrink-0">
                        {(score * 100).toFixed(0)}%
                      </span>
                    )}
                  </div>
                  {record.description && (
                    <p
                      className="text-[11px] text-muted-foreground mt-0.5 truncate"
                      title={record.description}
                    >
                      {record.description}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {query.isError && (
        <p className="text-xs text-destructive">Search failed: {query.error.message}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main widget export (mt#2373)
// ---------------------------------------------------------------------------

export function MemorySearch({ onResultClick, variant = "card", title = "Search Memories" }: MemorySearchProps) {
  const [inputValue, setInputValue] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [debounceTimer, setDebounceTimer] = useState<ReturnType<typeof setTimeout> | null>(null);

  function handleInput(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setInputValue(val);
    if (debounceTimer) clearTimeout(debounceTimer);
    const id = setTimeout(() => setDebouncedQuery(val), 300);
    setDebounceTimer(id);
  }

  const query = useQuery<WidgetData, Error>({
    queryKey: ["widget", "memories-search", debouncedQuery],
    queryFn: () =>
      fetchWidgetData(
        debouncedQuery.trim()
          ? `memories-search?q=${encodeURIComponent(debouncedQuery.trim())}`
          : "memories-search"
      ),
    staleTime: 20_000,
    enabled: true, // always enabled so empty state renders
  });

  return (
    <WidgetShell variant={variant} title={title}>
      <MemorySearchBody
        onResultClick={onResultClick}
        inputValue={inputValue}
        debouncedQuery={debouncedQuery}
        handleInput={handleInput}
        query={query}
      />
    </WidgetShell>
  );
}
