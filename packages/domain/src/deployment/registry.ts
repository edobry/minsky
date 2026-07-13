/**
 * Adapter registry for the deployment-platform abstraction.
 *
 * Adapters self-register at module load time. The MCP tools resolve an
 * adapter from a service's `DeploymentConfig` by looking up the
 * platform-name key. Unknown platform names throw a typed error rather than
 * silently falling back — explicit declaration is required.
 *
 * See docs/deployment-platforms.md for the full design.
 *
 * Tracking task: mt#1730.
 */

import type { DeploymentConfig, PlatformName } from "./config";
import type { DeploymentPlatformAdapter } from "./types";

export type AdapterFactory = (config: DeploymentConfig) => DeploymentPlatformAdapter;

const adapters = new Map<PlatformName, AdapterFactory>();

export function registerAdapter(name: PlatformName, factory: AdapterFactory): void {
  adapters.set(name, factory);
}

export function resolveAdapter(config: DeploymentConfig): DeploymentPlatformAdapter {
  const factory = adapters.get(config.platform);
  if (!factory) {
    throw new UnknownDeploymentPlatformError(config.platform, Array.from(adapters.keys()));
  }
  return factory(config);
}

export function getRegisteredPlatforms(): PlatformName[] {
  return Array.from(adapters.keys());
}

/** Test-only — clears the registry. */
export function _resetRegistryForTests(): void {
  adapters.clear();
}

export class UnknownDeploymentPlatformError extends Error {
  constructor(
    public readonly platform: string,
    public readonly registered: string[]
  ) {
    super(
      `Unknown deployment platform "${platform}". Registered: ` +
        `[${registered.join(", ") || "(none)"}]. ` +
        `Check services/<svc>/deploy.config.ts and ensure the adapter is registered.`
    );
    this.name = "UnknownDeploymentPlatformError";
  }
}
