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

      {/* mt#4762 PR #3492 R2: MemoryStats' own content (type badges, a 2-col
          quick-stats grid, a 5-row "most accessed" list) was designed for the
          ~1/3-page column it occupied in the old Search+Stats grid — at full
          page width it just stretches the card frame, leaving the right two
          thirds empty. Capping the width here is a page-layout call (this
          page's container, not the widget), not the widget redesign mt#4767
          owns; the widget's own markup is untouched. */}
      <div className="max-w-md">
        <MemoryStats />
      </div>

      {/* Main list — self-navigating (row click -> /memory/:id), own toolbar
          (filters + search), sortable server-driven columns. */}
      <MemoriesList />
    </div>
  );
}
