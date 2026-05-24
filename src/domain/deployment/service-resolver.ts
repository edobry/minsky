/**
 * Service-name → DeploymentConfig resolver.
 *
 * Reads `services/<svc>/deploy.config.ts` files. Resolution rules (per
 * docs/deployment-platforms.md):
 *
 *   1. If `service` is passed, load `services/<service>/deploy.config.ts`.
 *   2. If `service` is omitted AND the project has exactly one deploy.config.ts,
 *      use it.
 *   3. If `service` is omitted AND multiple are present, throw a typed error
 *      listing the available services.
 *
 * Tracking task: mt#1730.
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
 * Resolve a service name (or auto-select when there's exactly one) into a
 * loaded DeploymentConfig.
 *
 * @param service       Explicit service name, or undefined for auto-select.
 * @param projectRoot   Project root (default: cwd).
 */
export async function resolveDeploymentConfig(
  service: string | undefined,
  projectRoot: string = process.cwd()
): Promise<{ service: string; config: DeploymentConfig }> {
  if (service) {
    const config = await loadDeploymentConfig(service, projectRoot);
    return { service, config };
  }

  const available = listServicesWithDeployConfig(projectRoot);
  if (available.length === 0) {
    throw new NoDeploymentServicesError(resolveServicesDir(projectRoot));
  }
  if (available.length > 1) {
    throw new AmbiguousDeploymentServiceError(available);
  }
  const [onlyService] = available;
  if (!onlyService) {
    // Defensive — listServicesWithDeployConfig already returned length-1 here.
    throw new NoDeploymentServicesError(resolveServicesDir(projectRoot));
  }
  const config = await loadDeploymentConfig(onlyService, projectRoot);
  return { service: onlyService, config };
}
