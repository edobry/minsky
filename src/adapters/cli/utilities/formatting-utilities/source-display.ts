/**
 * Configuration Source Display Utilities
 *
 * Functions for rendering configuration with source annotations and
 * grouping effective values by their source file.
 */

import {
  formatResolvedConfiguration,
  formatResolvedConfigurationWithSources,
} from "./config-display";

/**
 * Format configuration sources for display (enhanced pretty format with source info)
 */
export function formatConfigurationSources(
  resolved: Record<string, unknown>,
  sources: Record<string, unknown>[],
  effectiveValues?: Record<string, { value: unknown; source: string; path: string }>
): string {
  let output = "📋 CONFIGURATION WITH SOURCES\n";
  output += "========================================\n";

  // Show source precedence
  output += "Source Precedence (highest to lowest):\n";
  sources.forEach((source, index) => {
    let sourceLine = `  ${index + 1}. ${source["name"]}`;
    if (source["path"]) {
      sourceLine += ` (${source["path"]})`;
    }
    output += `${sourceLine}\n`;
  });

  output += "\n";

  // Show enhanced configuration with source annotations
  if (effectiveValues) {
    output += formatResolvedConfigurationWithSources(resolved, effectiveValues);
  } else {
    output += formatResolvedConfiguration(resolved);
  }

  output += "\n\n💡 For per-value source details, use: minsky config list --sources";

  return output;
}

/**
 * Format individual configuration values with their sources
 */
export function formatEffectiveValueSources(
  effectiveValues: Record<string, { value: unknown; source: string; path: string }>,
  sources: Record<string, unknown>[]
): string {
  let output = "📋 CONFIGURATION VALUES BY SOURCE\n";
  output += "========================================\n";

  // Show source precedence first
  output += "Source Precedence (highest to lowest):\n";
  sources.forEach((source, index) => {
    output += `  ${index + 1}. ${source["name"]}\n`;
  });
  output += "\n";

  // Sort paths for consistent display
  const sortedPaths = Object.keys(effectiveValues).sort();

  // Group values by source for easier reading
  const valuesBySource: Record<string, Array<{ path: string; value: unknown }>> = {};

  for (const path of sortedPaths) {
    const valueInfo = effectiveValues[path];
    if (!valueInfo) continue;
    if (!valuesBySource[valueInfo.source]) {
      valuesBySource[valueInfo.source] = [];
    }
    valuesBySource[valueInfo.source]?.push({
      path,
      value: valueInfo.value,
    });
  }

  // Display values grouped by source
  for (const sourceObj of sources) {
    const sourceName = String(sourceObj["name"]);
    const values = valuesBySource[sourceName];
    if (values && values.length > 0) {
      // Show the source name and path if available
      let sourceHeader = `📂 FROM ${sourceName.toUpperCase()}`;
      if (sourceObj["path"]) {
        sourceHeader += ` (${sourceObj["path"]})`;
      }
      output += `${sourceHeader}:\n`;

      for (const { path, value } of values) {
        const displayValue = formatValueForDisplay(value);
        output += `   ${path}=${displayValue}\n`;
      }
      output += "\n";
    }
  }

  output += "💡 For flattened key=value pairs, use: minsky config list\n";
  output += "💡 For formatted configuration overview, use: minsky config show";

  return output;
}

/**
 * Format a configuration value for display
 */
export function formatValueForDisplay(value: unknown): string {
  if (value === null) return "(null)";
  if (value === undefined) return "(undefined)";
  if (Array.isArray(value)) {
    return value.length === 0 ? "(empty array)" : `(${value.length} items)`;
  }
  if (typeof value === "object") return `{${Object.keys(value).length} properties}`;
  // For strings, numbers, booleans - display as-is (they're already masked if sensitive)
  return String(value);
}
