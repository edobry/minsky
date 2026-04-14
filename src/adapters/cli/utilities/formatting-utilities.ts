/**
 * Barrel re-export for CLI formatting utilities.
 * Basic helpers: config-formatting-helpers.ts
 * Source display: config-formatting-sources.ts
 * Resolved config display: config-formatting-resolved.ts
 */

export type { ResolvedConfigShape } from "./config-formatting-helpers";
export {
  getBackendDisplayName,
  getSessionBackendDisplayName,
  formatDetectionCondition,
  sanitizeCredentials,
  formatConfigSection,
} from "./config-formatting-helpers";
export {
  formatConfigurationSources,
  formatEffectiveValueSources,
} from "./config-formatting-sources";
export {
  formatResolvedConfigurationWithSources,
  formatResolvedConfiguration,
} from "./config-formatting-resolved";
