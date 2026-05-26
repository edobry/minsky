import { z } from "zod";

/**
 * Workspace configuration schema
 * Provides a main workspace path used by in-tree task backends
 */
export const workspaceConfigSchema = z
  .object({
    /**
     * Absolute path to the main workspace root
     */
    mainPath: z.string().min(1).optional(),

    /**
     * The MCP client harness registered for this workspace (e.g. "cursor",
     * "claude-desktop"). Written by `minsky setup --client <X>` and stored
     * in `.minsky/config.local.yaml` so the chosen harness is remembered
     * across subsequent invocations.
     */
    harness: z.string().optional(),
  })
  .default({});

export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;
