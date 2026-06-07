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

export {
  computeMetricsSnapshot,
  deriveRestartCount,
  RailwayDeploymentAdapter,
  railwayAdapterFactory,
} from "./adapter";
export {
  fetchBuildLogs,
  fetchDeploymentLogs,
  fetchDeployments,
  fetchServiceMetrics,
  RailwayApiError,
  RailwayAuthError,
  type RailwayMetricDatapoint,
  type RailwayMetricSeries,
  readRailwayToken,
  SERVICE_METRIC_MEASUREMENTS,
  type ServiceMetricMeasurement,
} from "./graphql-client";
