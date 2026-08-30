import { MemoriesHealth } from "../widgets/MemoriesHealth";
import { MemoryStats } from "../widgets/MemoryStats";
import { MemoriesList } from "../widgets/MemoriesList";

/**
 * mt#4762: the standalone `<MemorySearch>` card (a third of the viewport for
 * one sentence of placeholder, and not composable with the table below it —
 * see the mt#4762 spec's `## Summary`) is retired FROM THIS PAGE. Search now
 * lives inside `MemoriesList`'s own toolbar — typing narrows the table in
 * place instead of rendering a separate result list. `MemorySearch.tsx`
 * itself is untouched: it stays registered as a standalone widget
 * (`src/cockpit/widget-registry.ts`) for any other render context that wants
 * the compact card form.
 */
export function MemoriesPage() {
  return (
    <div className="p-4 max-w-6xl mx-auto w-full space-y-4">
      {/* Page header with embeddings health indicator */}
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-base font-semibold text-foreground">Memories</h1>
        <MemoriesHealth />
      </div>

      <MemoryStats />

      {/* Main list — self-navigating (row click -> /memory/:id), own toolbar
          (filters + search), sortable server-driven columns. */}
      <MemoriesList />
    </div>
  );
}
