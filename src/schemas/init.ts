/**
 * Schema for init command parameters
 */

import { z } from "zod";

/**
 * Parameters for initializing a project
 */
export const initParamsSchema = z.object({
  repo: z.string().optional(),
  session: z.string().optional(),
  backend: z.string().optional(),
  ruleFormat: z.string().optional(),
  mcp: z.union([z.string(), z.boolean()]).optional(),
  mcpTransport: z.string().optional(),
  mcpPort: z.string().optional(),
  mcpHost: z.string().optional(),
  mcpOnly: z.boolean().optional(),
  overwrite: z.boolean().optional(),
  workspacePath: z.string().optional(),
});

/**
 * Type definition for init parameters
 */
export type InitParams = z.infer<typeof initParamsSchema>; 
