/**
 * MCP (Model Context Protocol) Configuration Schema
 *
 * Defines the project-level MCP transport preferences written to config.yaml
 * during `minsky init`. These represent project-level invariants, not
 * client-specific registration details.
 */

import { z } from "zod";

/**
 * MCP configuration schema
 */
export const mcpConfigSchema = z
  .object({
    transport: z.enum(["stdio", "sse", "httpStream"]).default("stdio"),
    port: z.number().optional(),
    host: z.string().optional(),
  })
  .optional();

export type McpConfig = z.infer<typeof mcpConfigSchema>;
