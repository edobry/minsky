/**
 * Cockpit memory curation mutation hooks (mt#4766).
 *
 * Thin `fetch` wrappers around the `/api/memories/*` write routes
 * (`src/cockpit/routes/memories.ts`), plus TanStack Query `useMutation` hooks
 * that invalidate the `memories-list` / `memories-search` / `memories-detail`
 * widget queries on success so the UI reflects a change without a manual
 * reload (a Success Criterion). Mirrors the `resolveAsk`/`deferAsk` fetch
 * convention in `AskDetail.tsx` and the `useInlineAskActions` hook shape in
 * `AsksPage.tsx`.
 *
 * These functions send exactly the fields the corresponding route whitelists
 * (see `memories.ts`'s `UPDATE_ALLOWED_FIELDS` / `SUPERSEDE_ALLOWED_FIELDS`) —
 * in particular, `supersedeMemory` never sends a `sourceAgentId` /
 * `sourceSessionId`: the server ascribes those unconditionally
 * (`COCKPIT_OPERATOR_SOURCE_AGENT_ID`).
 */
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { MemoryRecord, MemoryType, MemoryScope } from "@minsky/domain/memory/types";

async function readErrorBody(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? res.statusText;
  } catch {
    return res.statusText;
  }
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  if (!res.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${url} failed (${res.status}): ${await readErrorBody(res)}`
    );
  }
  return res.json() as Promise<T>;
}

// ─── Single-record fetch functions ───────────────────────────────────────────

export interface MemoryUpdateInput {
  name?: string;
  description?: string;
  tags?: string[];
  associations?: Record<string, string[]>;
}

export async function updateMemory(
  id: string,
  fields: MemoryUpdateInput
): Promise<{ record: MemoryRecord }> {
  return requestJson(`/api/memories/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(fields),
  });
}

export interface MemorySupersedeInput {
  type: MemoryType;
  name: string;
  description: string;
  content: string;
  scope: MemoryScope;
  projectId?: string | null;
  tags?: string[];
  confidence?: number;
  reason?: string;
}

export async function supersedeMemory(
  oldId: string,
  input: MemorySupersedeInput
): Promise<{ old: MemoryRecord; replacement: MemoryRecord }> {
  return requestJson(`/api/memories/${encodeURIComponent(oldId)}/supersede`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function deleteMemory(id: string): Promise<{ deleted: boolean; id: string }> {
  return requestJson(`/api/memories/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ─── Bulk fetch functions — dry-run-first (`operational-safety-dry-run-first`) ─

export interface BulkRetagPreview {
  preview: true;
  changes: Array<{ id: string; name?: string; currentTags?: string[]; newTags: string[] }>;
}
export interface BulkRetagExecuted {
  executed: true;
  changed: string[];
}

export async function bulkRetagMemories(
  ids: string[],
  tags: string[],
  execute: boolean
): Promise<BulkRetagPreview | BulkRetagExecuted> {
  return requestJson("/api/memories/bulk/retag", {
    method: "POST",
    body: JSON.stringify({ ids, tags, execute }),
  });
}

export interface BulkDeletePreview {
  preview: true;
  changes: Array<{ id: string; name: string }>;
}
export interface BulkDeleteExecuted {
  executed: true;
  deleted: string[];
}

export async function bulkDeleteMemories(
  ids: string[],
  execute: boolean
): Promise<BulkDeletePreview | BulkDeleteExecuted> {
  return requestJson("/api/memories/bulk/delete", {
    method: "POST",
    body: JSON.stringify({ ids, execute }),
  });
}

// ─── TanStack Query hooks ─────────────────────────────────────────────────────

/**
 * Invalidate every widget query a memory mutation can affect.
 *
 * Partial-key invalidation (`queryKey: ["widget", "memories-list"]` matches
 * every query whose key STARTS WITH that prefix, TanStack's default) covers
 * `memories-list` and `memories-search` regardless of their trailing
 * sort/filter/page params — same convention `useInlineAskActions`'s `settle()`
 * uses for `["asks"]`.
 */
function invalidateMemoryQueries(queryClient: QueryClient, id?: string): void {
  void queryClient.invalidateQueries({ queryKey: ["widget", "memories-list"] });
  void queryClient.invalidateQueries({ queryKey: ["widget", "memories-search"] });
  void queryClient.invalidateQueries({ queryKey: ["widget", "memories-stats"] });
  if (id) {
    void queryClient.invalidateQueries({ queryKey: ["widget", "memories-detail", id] });
  }
}

export function useUpdateMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, fields }: { id: string; fields: MemoryUpdateInput }) =>
      updateMemory(id, fields),
    onSuccess: (_data, variables) => invalidateMemoryQueries(queryClient, variables.id),
  });
}

export function useSupersedeMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ oldId, input }: { oldId: string; input: MemorySupersedeInput }) =>
      supersedeMemory(oldId, input),
    onSuccess: (_data, variables) => invalidateMemoryQueries(queryClient, variables.oldId),
  });
}

export function useDeleteMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteMemory(id),
    onSuccess: (_data, id) => invalidateMemoryQueries(queryClient, id),
  });
}

export function useBulkRetagMemories() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, tags, execute }: { ids: string[]; tags: string[]; execute: boolean }) =>
      bulkRetagMemories(ids, tags, execute),
    onSuccess: (data, variables) => {
      if (variables.execute) invalidateMemoryQueries(queryClient);
      return data;
    },
  });
}

export function useBulkDeleteMemories() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, execute }: { ids: string[]; execute: boolean }) =>
      bulkDeleteMemories(ids, execute),
    onSuccess: (data, variables) => {
      if (variables.execute) invalidateMemoryQueries(queryClient);
      return data;
    },
  });
}
