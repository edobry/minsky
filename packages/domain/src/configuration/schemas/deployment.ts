import { z } from "zod";

/**
 * Deployment-tooling configuration (mt#2821).
 *
 * `defaultService` disambiguates `deployment_status` / `deployment_wait-for-latest`
 * / `deployment_logs` when the project declares more than one
 * `services/<svc>/deploy.config.ts` and no explicit `service` argument is
 * passed — see `packages/domain/src/deployment/service-resolver.ts`'s
 * `resolveDeploymentConfig`. This reuses Minsky's EXISTING configuration
 * surface (`config.get`/`config.set`/`config.show`, project/user YAML)
 * rather than introducing a new config subsystem for the one field.
 *
 * `strictObject` so typos inside the slot fail loud at load time (mirrors
 * `railwayConfigSchema`'s convention).
 */
export const deploymentConfigSchema = z
  .strictObject({
    /**
     * Service name (matches `services/<name>/deploy.config.ts`) to use by
     * default when a deployment tool is called without an explicit
     * `service` and the project has multiple deploy.config.ts files.
     */
    defaultService: z.string().optional(),
  })
  .optional();

/**
 * Named `DeploymentSectionConfig` (not `DeploymentConfig`) to avoid
 * colliding with the unrelated `DeploymentConfig` type in
 * `packages/shared/src/deployment/config.ts` — the per-service
 * `deploy.config.ts` shape (`{ platform, railway, healthUrl }`). Both names
 * can end up imported in the same file (e.g. the deployment command
 * adapter), so a shared name would be a footgun.
 */
export type DeploymentSectionConfig = z.infer<typeof deploymentConfigSchema>;
