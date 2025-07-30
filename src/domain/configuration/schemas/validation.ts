/**
 * Validation Configuration Schema
 *
 * Defines the schema for controlling configuration validation behavior,
 * including strict mode and warning preferences for unknown fields.
 */

import { z } from "zod";

/**
 * Validation configuration
 */
export const validationConfigSchema = z
  .object({
    // Whether to use strict validation (reject unknown fields)
    strictMode: z.boolean().default(false),

    // Whether to show warnings for unknown configuration fields
    warnOnUnknown: z.boolean().default(true),

    // Whether to show path information in unknown field warnings
    includePathInWarnings: z.boolean().default(true),

    // Whether to include the validation error code in warnings
    includeCodeInWarnings: z.boolean().default(false),
  })
  .strict()
  .default({
    strictMode: false,
    warnOnUnknown: true,
    includePathInWarnings: true,
    includeCodeInWarnings: false,
  });

// Type exports
export type ValidationConfig = z.infer<typeof validationConfigSchema>;

/**
 * Validation functions for validation configuration
 */
export const validationConfigValidation = {
  /**
   * Check if strict mode is enabled
   */
  isStrictModeEnabled: (config: ValidationConfig): boolean => {
    return config.strictMode;
  },

  /**
   * Check if warnings should be shown for unknown fields
   */
  shouldWarnOnUnknown: (config: ValidationConfig): boolean => {
    return config.warnOnUnknown;
  },

  /**
   * Check if path information should be included in warnings
   */
  shouldIncludePathInWarnings: (config: ValidationConfig): boolean => {
    return config.includePathInWarnings;
  },

  /**
   * Check if validation error codes should be included in warnings
   */
  shouldIncludeCodeInWarnings: (config: ValidationConfig): boolean => {
    return config.includeCodeInWarnings;
  },
} as const;

/**
 * Environment variable mapping for validation configuration
 */
export const validationEnvMapping = {
  // Validation settings
  MINSKY_VALIDATION_STRICT_MODE: "validation.strictMode",
  MINSKY_VALIDATION_WARN_ON_UNKNOWN: "validation.warnOnUnknown",
  MINSKY_VALIDATION_INCLUDE_PATH_IN_WARNINGS: "validation.includePathInWarnings",
  MINSKY_VALIDATION_INCLUDE_CODE_IN_WARNINGS: "validation.includeCodeInWarnings",
} as const;
