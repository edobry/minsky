/**
 * Minsky stdio respawn proxy — public API.
 *
 * Export surface for consumers (CLI registration, tests).
 *
 * @see docs/architecture/stdio-proxy.md
 * @see src/commands/mcp/index.ts — CLI registration site
 */

export { MinskyStdioProxy, runProxy, type ProxyOptions } from "./proxy";
export {
  PROXY_RESTART_TOOL_NAME,
  PROXY_RESTART_TOOL_ENTRY,
  augmentToolsListResponse,
  isProxyRestartRequest,
  makeToolCallResponse,
  type JsonRpcMessage,
  type McpTool,
} from "./tools";
export { createProxyCommand } from "./cli";
