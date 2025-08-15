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
  })
  .default({});

export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;
