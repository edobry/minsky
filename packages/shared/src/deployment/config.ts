/**
 * Platform-neutral deployment configuration types and factory.
 *
 * Lives in @minsky/shared so service-boundary config files
 * (services/<svc>/deploy.config.ts) can import the factory without crossing
 * the deploy boundary (eslint-rules/no-escape-deploy-context.js).
 *
 * The runtime-side concerns (adapter registry, service resolution, adapter
 * implementations) live in src/domain/deployment/ and import these types
 * from here.
 *
 * See docs/deployment-platforms.md for the full design.
 *
 * Tracking task: mt#1730.
 */

/**
 * Registered platform discriminator. Extended by new adapters as they ship.
 */
export type PlatformName = "railway";

/**
 * Railway-specific config block. Mirrors the IDs that
 * `scripts/railway/lib.ts`'s `defineRailwayConfig` declares, so Railway
 * services can import IDs from their existing `railway.config.ts` rather
 * than duplicating them.
 */
export interface RailwayDeploymentConfig {
  projectId: string;
  environmentId: string;
  serviceId: string;
}

/**
 * Discriminated union over platform-specific config blocks. Adding a new
 * platform extends this type with a new variant and a new entry in
 * `PlatformName`.
 */
export type DeploymentConfig = {
  platform: "railway";
  railway: RailwayDeploymentConfig;
};

/**
 * Factory used by `services/<svc>/deploy.config.ts` files. Pure pass-through
 * today; the typed shape is what catches misconfiguration at authoring time.
 *
 * ```ts
 * // services/minsky-mcp/deploy.config.ts
 * import { defineDeployment } from "@minsky/shared/deployment-config";
 *
 * export default defineDeployment({
 *   platform: "railway",
 *   railway: { projectId: "...", environmentId: "...", serviceId: "..." },
 * });
 * ```
 */
export function defineDeployment(config: DeploymentConfig): DeploymentConfig {
  return config;
}

export function isPlatformName(value: string): value is PlatformName {
  return value === "railway";
}
