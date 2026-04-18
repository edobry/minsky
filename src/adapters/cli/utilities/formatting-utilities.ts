/**
 * CLI Formatting Utilities
 *
 * Barrel re-export — sub-modules contain the actual implementations:
 *   - formatting-utilities/basic-utils.ts   — getBackendDisplayName,
 *       getSessionBackendDisplayName, formatDetectionCondition,
 *       sanitizeCredentials, formatConfigSection, ResolvedConfigShape
 *   - formatting-utilities/config-display.ts — formatResolvedConfiguration,
 *       formatResolvedConfigurationWithSources
 *   - formatting-utilities/source-display.ts — formatConfigurationSources,
 *       formatEffectiveValueSources, formatValueForDisplay
 */

export type { ResolvedConfigShape } from "./formatting-utilities/basic-utils";
export {
  getBackendDisplayName,
  getSessionBackendDisplayName,
  formatDetectionCondition,
  sanitizeCredentials,
  formatConfigSection,
} from "./formatting-utilities/basic-utils";

export {
  formatResolvedConfiguration,
  formatResolvedConfigurationWithSources,
} from "./formatting-utilities/config-display";

export {
  formatConfigurationSources,
  formatEffectiveValueSources,
  formatValueForDisplay,
} from "./formatting-utilities/source-display";
