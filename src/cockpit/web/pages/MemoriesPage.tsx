import { useState, useCallback } from "react";
import { MemoriesHealth } from "../widgets/MemoriesHealth";
import { MemorySearch } from "../widgets/MemorySearch";
import { MemoryStats } from "../widgets/MemoryStats";
import { MemoriesList } from "../widgets/MemoriesList";
import { MemoryDetail } from "../widgets/MemoryDetail";
import type { MemoryRecord } from "@minsky/domain/memory/types";

export function MemoriesPage() {
  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(null);

  const handleRowClick = useCallback((record: MemoryRecord) => {
    setSelectedMemoryId(record.id);
  }, []);

  const handleClose = useCallback(() => {
    setSelectedMemoryId(null);
  }, []);

  const handleNavigate = useCallback((id: string) => {
    setSelectedMemoryId(id);
  }, []);

  return (
    <div className="p-4 max-w-6xl mx-auto w-full space-y-4">
      {/* Page header with embeddings health indicator */}
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-base font-semibold text-foreground">Memories</h1>
        <MemoriesHealth />
      </div>

      {/* Search + Stats row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <MemorySearch onResultClick={handleRowClick} />
        </div>
        <div className="lg:col-span-1">
          <MemoryStats />
        </div>
      </div>

      {/* Main list — takes remaining space */}
      <MemoriesList onRowClick={handleRowClick} />

      {/* Detail panel (slide-in dialog) */}
      <MemoryDetail
        memoryId={selectedMemoryId}
        onClose={handleClose}
        onNavigate={handleNavigate}
      />
    </div>
  );
}
