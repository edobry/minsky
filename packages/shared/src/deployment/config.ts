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
 * Tracking task: mt#1730. Extended in mt#1964 with optional source + build
 * blocks for deploy-trigger reconciliation.
 */

/**
 * Registered platform discriminator. Extended by new adapters as they ship.
 */
export type PlatformName = "railway";

/**
 * Railway build-system selector.
 *
 * Structural mirror of `RailwayBuilder` in `scripts/railway/lib.ts`. The
 * synthesizer (chunk 2 / mt#2000) reads this discriminator to map to
 * Railway's `ServiceInstanceUpdateInput.builder` field. The duplication
 * here is intentional: this package must not import from scripts/ per
 * `eslint-rules/no-escape-deploy-context.js`. If new builders are added,
 * update both this type and `scripts/railway/lib.ts` together.
 */
export type RailwayBuilder = "NIXPACKS" | "DOCKERFILE" | "RAILPACK";

/**
 * Source-repo binding for a Railway service. Optional on
 * `RailwayDeploymentConfig` — services that haven't been migrated to
 * declarative deploy-trigger config (mt#1964 chunk 3 / mt#2001) omit this.
 *
 * `repo` and `branch` are optional (mt#2001 relaxation): some services
 * deploy via project-level Railway GitHub App integration and have
 * `source: null` on the serviceInstance — but `rootDirectory` (which IS
 * a top-level serviceInstance field) is still worth declaring for drift
 * detection. Such services declare `{ rootDirectory: "..." }` only.
 */
export interface RailwaySource {
  repo?: string;
  branch?: string;
  rootDirectory?: string;
  /** Optional check-suite branch filter — per Railway's source.checkSuites. */
  checkSuites?: string[];
}

/**
 * Build configuration for a Railway service. Optional on
 * `RailwayDeploymentConfig` — services that haven't been migrated to
 * declarative deploy-trigger config omit this.
 */
export interface RailwayBuild {
  builder: RailwayBuilder;
  /** Required when builder === "DOCKERFILE". */
  dockerfilePath?: string;
  buildCommand?: string;
  watchPatterns?: string[];
  nixpacksConfigPath?: string;
}

/**
 * Railway-specific config block. Mirrors the IDs that
 * `scripts/railway/lib.ts`'s `defineRailwayConfig` declares, so Railway
 * services can import IDs from their existing `railway.config.ts` rather
 * than duplicating them.
 *
 * `source` and `build` are optional (mt#1964 chunk 1). When present, the
 * synthesizer (mt#2000) reconciles them against the live Railway service.
 * When absent, the synthesizer skips the deploy-trigger pass for that
 * service (env-var-only synthesis continues to work).
 */
export interface RailwayDeploymentConfig {
  projectId: string;
  environmentId: string;
  serviceId: string;
  /** Deploy-trigger source binding (mt#1964 chunk 1). */
  source?: RailwaySource;
  /** Build-system configuration (mt#1964 chunk 1). */
  build?: RailwayBuild;
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
 *   railway: {
 *     projectId: "...",
 *     environmentId: "...",
 *     serviceId: "...",
 *     // Optional (mt#1964) — declare source/build for the deploy-trigger
 *     // synthesizer to reconcile. Omit for services not yet migrated.
 *     source: { repo: "edobry/minsky", branch: "main", rootDirectory: "services/site" },
 *     build: { builder: "NIXPACKS" },
 *   },
 * });
 * ```
 */
export function defineDeployment(config: DeploymentConfig): DeploymentConfig {
  return config;
}

export function isPlatformName(value: string): value is PlatformName {
  return value === "railway";
}
