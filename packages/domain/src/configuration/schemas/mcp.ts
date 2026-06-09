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

    /**
     * Operator->service auth for the hosted Minsky MCP endpoint.
     */
    auth: z
      .object({
        /**
         * Bearer token the operator presents to the hosted Minsky MCP endpoint.
         * Sourced from `MINSKY_MCP_AUTH_TOKEN` (env source, highest priority) or
         * set directly in config. Consumed by `reviewer.retrigger` (mt#2346) to
         * authenticate against the reviewer service's `/retrigger` endpoint — the
         * reviewer service holds the same token, so on-demand triggering never
         * needs the webhook HMAC secret. Promoted from `HOOK_ONLY_ENV_VARS` to a
         * real config path per its standing TODO.
         */
        token: z.string().min(1).optional(),
      })
      .optional(),
  })
  .optional();

export type McpConfig = z.infer<typeof mcpConfigSchema>;
