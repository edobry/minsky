/**
 * Re-export of the platform-neutral deployment config types and factory.
 *
 * The canonical definitions live in @minsky/shared so service-boundary
 * config files (services/<svc>/deploy.config.ts) can import the factory
 * without crossing the deploy boundary. This module re-exports them for
 * the runtime side of the codebase.
 *
 * Tracking task: mt#1730.
 */

export {
  defineDeployment,
  isPlatformName,
  type DeploymentConfig,
  type PlatformName,
  type RailwayDeploymentConfig,
} from "@minsky/shared/deployment-config";
