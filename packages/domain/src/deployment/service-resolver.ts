/**
 * Service-name → DeploymentConfig resolver.
 *
 * Reads `services/<svc>/deploy.config.ts` files. Resolution rules (per
 * docs/deployment-platforms.md, extended by mt#2821):
 *
 *   1. If `service` is passed, load `services/<service>/deploy.config.ts`.
 *   2. If `service` is omitted AND the project has exactly one deploy.config.ts,
 *      use it.
 *   3. If `service` is omitted AND multiple are present, try a configured
 *      default service (`options.configuredDefaultService`), then
 *      unambiguous runtime inference (`inferRunningService`).
 *   4. If neither resolves, throw a typed error listing every candidate
 *      service name.
 *
 * Tracking task: mt#1730. Multi-service disambiguation: mt#2821.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { DeploymentConfig } from "./config";

export class DeploymentConfigNotFoundError extends Error {
  constructor(
    public readonly service: string,
    public readonly searchedPath: string
  ) {
    super(`No deploy.config.ts found for service "${service}". ` + `Looked for: ${searchedPath}`);
    this.name = "DeploymentConfigNotFoundError";
  }
}

export class AmbiguousDeploymentServiceError extends Error {
  constructor(public readonly availableServices: string[]) {
    super(
      `Multiple services have deploy.config.ts files (${availableServices.join(", ")}). ` +
        `Pass an explicit service name.`
    );
    this.name = "AmbiguousDeploymentServiceError";
  }
}

export class NoDeploymentServicesError extends Error {
  constructor(public readonly servicesDir: string) {
    super(
      `No services with deploy.config.ts found under ${servicesDir}. ` +
        `Create services/<svc>/deploy.config.ts to declare a deployment target.`
    );
    this.name = "NoDeploymentServicesError";
  }
}

/**
 * Project root that contains the `services/` directory. Defaults to the
 * current working directory; override via the `projectRoot` argument for
 * tests or non-cwd contexts.
 */
function resolveServicesDir(projectRoot: string = process.cwd()): string {
  return join(projectRoot, "services");
}

/**
 * Enumerate service names that have a `deploy.config.ts`.
 */
export function listServicesWithDeployConfig(projectRoot: string = process.cwd()): string[] {
  const servicesDir = resolveServicesDir(projectRoot);
  if (!existsSync(servicesDir)) return [];

  const out: string[] = [];
  for (const entry of readdirSync(servicesDir)) {
    const entryPath = join(servicesDir, entry);
    try {
      if (!statSync(entryPath).isDirectory()) continue;
    } catch {
      continue;
    }
    if (existsSync(join(entryPath, "deploy.config.ts"))) {
      out.push(entry);
    }
  }
  return out.sort();
}

/**
 * Load a service's deploy.config.ts module and return its default export.
 */
async function loadDeploymentConfig(
  service: string,
  projectRoot: string
): Promise<DeploymentConfig> {
  const configPath = resolve(projectRoot, "services", service, "deploy.config.ts");
  if (!existsSync(configPath)) {
    throw new DeploymentConfigNotFoundError(service, configPath);
  }
  const mod = (await import(pathToFileURL(configPath).href)) as {
    default?: DeploymentConfig;
  };
  if (!mod.default) {
    throw new Error(
      `services/${service}/deploy.config.ts has no default export. ` +
        `Did you forget \`export default defineDeployment({...})\`?`
    );
  }
  return mod.default;
}

/**
 * Options for the multi-service disambiguation fallbacks (mt#2821).
 */
export interface ResolveDeploymentConfigOptions {
  /**
   * A configured default service name (from Minsky's EXISTING config
   * surface — `deployment.defaultService`, read via
   * `getConfigurationProvider()` — see
   * `src/adapters/shared/commands/deployment.ts`). Checked when `service`
   * is omitted and multiple candidates exist. Passed in as a plain value
   * (rather than read here) so this module has zero dependency on the
   * configuration system and stays trivially unit-testable without
   * initializing the global config provider.
   */
  configuredDefaultService?: string;
}

/**
 * Best-effort match of the CURRENTLY RUNNING process against one of the
 * candidate services' declared Railway `serviceId`, using the
 * platform-injected `RAILWAY_SERVICE_ID` environment variable — a standard
 * Railway system variable (https://docs.railway.com/variables/reference),
 * automatically present in every Railway-hosted container, naming that
 * container's OWN service. This is genuinely unambiguous (the platform's
 * ground truth for "which service am I", not a guess) and requires no
 * configuration: it naturally no-ops for local/dev invocations, where the
 * variable is absent, falling through to the ambiguity error.
 *
 * Exported for direct unit testing.
 */
export async function inferRunningService(
  available: string[],
  projectRoot: string
): Promise<{ service: string; config: DeploymentConfig } | undefined> {
  const runningServiceId = process.env.RAILWAY_SERVICE_ID;
  if (!runningServiceId) return undefined;

  for (const candidate of available) {
    let config: DeploymentConfig;
    try {
      config = await loadDeploymentConfig(candidate, projectRoot);
    } catch {
      continue;
    }
    if (config.platform === "railway" && config.railway.serviceId === runningServiceId) {
      return { service: candidate, config };
    }
  }
  return undefined;
}

/**
 * Resolve a service name into a loaded DeploymentConfig.
 *
 * Resolution order when `service` is omitted (per
 * docs/deployment-platforms.md, extended by mt#2821):
 *   1. Exactly one `deploy.config.ts` exists — auto-select it.
 *   2. Multiple exist — try `options.configuredDefaultService`.
 *   3. Multiple exist and no configured default matched — try
 *      `inferRunningService` (RAILWAY_SERVICE_ID match).
 *   4. Otherwise — throw `AmbiguousDeploymentServiceError` listing every
 *      candidate service name.
 *
 * @param service       Explicit service name, or undefined for auto-select.
 * @param projectRoot   Project root (default: cwd).
 * @param options       Multi-service disambiguation fallbacks (mt#2821).
 */
export async function resolveDeploymentConfig(
  service: string | undefined,
  projectRoot: string = process.cwd(),
  options: ResolveDeploymentConfigOptions = {}
): Promise<{ service: string; config: DeploymentConfig }> {
  if (service) {
    const config = await loadDeploymentConfig(service, projectRoot);
    return { service, config };
  }

  const available = listServicesWithDeployConfig(projectRoot);
  if (available.length === 0) {
    throw new NoDeploymentServicesError(resolveServicesDir(projectRoot));
  }

  if (available.length === 1) {
    const [onlyService] = available;
    if (!onlyService) {
      // Defensive — listServicesWithDeployConfig already returned length-1 here.
      throw new NoDeploymentServicesError(resolveServicesDir(projectRoot));
    }
    const config = await loadDeploymentConfig(onlyService, projectRoot);
    return { service: onlyService, config };
  }

  // Multiple candidates and no explicit service (mt#2821): try the
  // configured default, then unambiguous runtime inference, before giving
  // up with the ambiguity error (which lists every candidate).
  if (options.configuredDefaultService && available.includes(options.configuredDefaultService)) {
    const config = await loadDeploymentConfig(options.configuredDefaultService, projectRoot);
    return { service: options.configuredDefaultService, config };
  }

  const inferred = await inferRunningService(available, projectRoot);
  if (inferred) {
    return inferred;
  }

  throw new AmbiguousDeploymentServiceError(available);
}
