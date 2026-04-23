/**
 * Memory Configuration Schema
 *
 * Controls how agent memory is loaded. The `loadingMode` flag governs whether
 * the memory-usage directive is emitted in compiled CLAUDE.md output.
 *
 * - `"on_demand"` (default): the `memory-usage` alwaysApply rule is emitted,
 *   instructing the agent to call `memory_search` at conversation start.
 * - `"legacy"`: the directive is suppressed; the agent relies on the native
 *   Claude Code MEMORY.md preamble loader instead.
 */

import { z } from "zod";

export const memoryLoadingModeSchema = z.enum(["legacy", "on_demand"]);

export const memoryConfigSchema = z
  .object({
    /**
     * Controls how agent memory is loaded.
     *
     * - `"on_demand"` (default): emit the memory-usage directive in CLAUDE.md,
     *   so the agent calls `memory_search` at conversation start.
     * - `"legacy"`: suppress the directive; rely on the MEMORY.md preamble loader.
     */
    loadingMode: memoryLoadingModeSchema.default("on_demand"),
  })
  .default({ loadingMode: "on_demand" });

export type MemoryLoadingMode = z.infer<typeof memoryLoadingModeSchema>;
export type MemoryConfig = z.infer<typeof memoryConfigSchema>;
