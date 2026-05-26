/**
 * Railway deployment-platform adapter. Self-registers with the adapter
 * registry on module load so the MCP tools resolve it without explicit
 * wiring at each call site.
 *
 * Tracking task: mt#1730.
 */

import { registerAdapter } from "../registry";
import { railwayAdapterFactory } from "./adapter";

registerAdapter("railway", railwayAdapterFactory);

export { RailwayDeploymentAdapter, railwayAdapterFactory } from "./adapter";
export {
  fetchBuildLogs,
  fetchDeploymentLogs,
  fetchDeployments,
  RailwayApiError,
  RailwayAuthError,
  readRailwayToken,
} from "./graphql-client";
