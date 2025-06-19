/**
 * Schema Bridge
 *
 * This module provides utilities to bridge between Zod schemas and CLI options.
 * It enables consistent validation across interfaces and ensures type safety.
 */
import { Command } from "commander";
import { z } from "zod";
import type { CommandParameter, CommandParameterMap } from "./command-registry.js";
/**
 * Type for CLI option flag definition
 */
export interface OptionFlag {
  /** The option flag (e.g., "-f, --format <type>") */
  flag: string;
  /** Option description */
  description: string;
  /** Default value */
  defaultValue?: string | boolean | string[];
}

/**
 * Type for CLI option details
 */
export interface CliOptionDetails {
  /** The long flag name without dashes (e.g., "format") */
  name: string;
  /** Whether the option is required */
  required: boolean;
  /** Full flag definition */
  flag: string;
  /** Option description */
  description: string;
  /** Default value if any */
  defaultValue?: unknown;
}

/**
 * Convert a parameter name to a CLI option flag
 *
 * @param name Parameter name
 * @returns Normalized CLI option name
 */
export function paramNameToFlag(name: string): string {
  // Convert camelCase to kebab-case
  return name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}

/**
 * Create a CLI option flag from a parameter name
 *
 * @param name Parameter name
 * @param shortFlag Optional short flag (single character)
 * @returns CLI option flag (e.g., "--flag <value>" or "-f, --flag <value>")
 */
export function createOptionFlag(name: string, shortFlag?: string): string {
  const flagName = paramNameToFlag(name);
  const base = `--${flagName}`;

  if (shortFlag) {
    return `-${shortFlag}, ${base}`;
  }

  return base;
}

/**
 * Format an option flag with value placeholder based on schema type
 *
 * @param flag Base flag string
 * @param schema Zod schema for the parameter
 * @returns Formatted flag string with value placeholder
 */
export function addValuePlaceholder(flag: string, schema: z.ZodTypeAny): string {
  // Determine if the parameter takes a value
  const isBooleanType =
    schema instanceof z.ZodBoolean ||
    (schema instanceof z.ZodOptional && schema._def.innerType instanceof z.ZodBoolean);

  // Boolean options don't need a value placeholder
  if (isBooleanType) {
    return flag;
  }

  // Determine the placeholder text based on schema type
  let placeholder = "value";

  if (schema instanceof z.ZodString) {
    placeholder = "string";
  } else if (schema instanceof z.ZodNumber) {
    placeholder = "number";
  } else if (schema instanceof z.ZodEnum) {
    placeholder = "enum";
  } else if (schema instanceof z.ZodOptional) {
    // Recurse to check the inner type
    return addValuePlaceholder(flag, schema._def.innerType);
  }

  return `${flag} <${placeholder}>`;
}

/**
 * Get the description for an option based on Zod schema
 *
 * @param schema Zod schema with optional description
 * @param fallback Fallback description if schema has none
 * @returns Option description string
 */
export function getSchemaDescription(
  schema: z.ZodTypeAny,
  fallback: string = "No description available"
): string {
  // Try to extract description from schema
  let description = fallback;

  // Check if we have a description in the schema
  if (
    "description" in schema &&
    typeof schema.description === "string" &&
    schema.description.length > 0
  ) {
    description = schema.description;
  } else if (schema instanceof z.ZodOptional && "description" in schema._def.innerType) {
    const innerDesc = schema._def.innerType.description;
    if (typeof innerDesc === "string" && innerDesc.length > 0) {
      description = innerDesc;
    }
  }

  return description;
}

/**
 * Extract enum values from a Zod enum schema
 *
 * @param schema Zod enum schema
 * @returns Array of enum values
 */
export function getEnumValues(schema: z.ZodEnum<[string, ...string[]]>): string[] {
  return schema._def.values;
}

/**
 * Convert a Zod schema parameter to a CLI option flag definition
 *
 * @param name Parameter name
 * @param param Command parameter with Zod schema
 * @param shortFlag Optional short flag override
 * @returns CLI option flag definition
 */
export function parameterToOptionFlag(
  name: string,
  param: CommandParameter,
  shortFlag?: string
): OptionFlag {
  // Create the base flag
  let flag = createOptionFlag(name, shortFlag);

  // Add value placeholder if needed
  flag = addValuePlaceholder(flag, param.schema);

  // Get description
  const description = param.description || getSchemaDescription(param.schema);

  let defaultValue = param.defaultValue;
  // Ensure defaultValue is compatible with Commander
  if (
    defaultValue !== undefined &&
    typeof defaultValue !== "string" &&
    typeof defaultValue !== "boolean" &&
    !Array.isArray(defaultValue)
  ) {
    // If it's an object or other incompatible type, try to stringify or set to undefined
    // This is a basic attempt; more sophisticated handling might be needed based on use cases
    defaultValue =
      typeof defaultValue === "object" ? JSON.stringify(defaultValue) : String(defaultValue);
    // If after stringification, it's still not a primitive that commander accepts, or if it's an empty array (commander might not like empty array as default for non-array types)
    if (typeof defaultValue !== "string" && typeof defaultValue !== "boolean") {
      defaultValue = undefined; // Fallback to undefined if conversion is problematic
    }
  } else if (defaultValue === null) {
    defaultValue = undefined;
  }

  return {
    flag,
    description,
    defaultValue: defaultValue as string | boolean | string[] | undefined,
  };
}

/**
 * Add CLI options to a Commander command based on parameters
 *
 * @param command Commander command to add options to
 * @param parameters Map of parameter definitions
 * @param shortFlags Optional map of parameter names to short flags
 * @returns The command with options added
 */
export function addOptionsToCommand(
  command: Command,
  parameters: CommandParameterMap,
  shortFlags: Record<string, string> = {}
): Command {
  // For each parameter, add an option to the command
  Object.entries(parameters).forEach(([name, param]) => {
    const { flag, description, defaultValue } = parameterToOptionFlag(
      name,
      param,
      shortFlags[name]
    );

    // Add the option to the command
    if (defaultValue !== undefined) {
      command.option(flag, description, defaultValue);
    } else {
      command.option(flag, description);
    }
  });

  return command;
}

/**
 * Parse CLI options into a structured object based on parameter schemas
 *
 * @param options CLI options object from Commander
 * @param parameters Map of parameter definitions with schemas
 * @returns Validated object with parsed parameters
 */
export function parseOptionsToParameters<T extends CommandParameterMap>(
  options: Record<string, unknown>,
  parameters: T
): { [K in keyof T]: z.infer<T[K]["schema"]> } {
  // Create result object
  const result: Record<string, unknown> = {};

  // For each parameter, validate and convert the option
  Object.entries(parameters).forEach(([name, param]) => {
    const optionName = paramNameToFlag(name).replace(/-/g, "");
    const value = options[optionName];

    // If value is present, validate and add to result
    if (value !== undefined) {
      // Use the schema to validate and transform
      try {
        result[name] = param.schema.parse(value);
      } catch (error) {
        // Re-throw with more context
        throw new Error(`Invalid value for parameter '${name}': ${error}`);
      }
    } else if (param.required) {
      // Required parameter is missing
      throw new Error(`Missing required parameter: ${name}`);
    } else if (param.defaultValue !== undefined) {
      // Use default value
      result[name] = param.defaultValue;
    }
  });

  // Cast to expected type
  return result as { [K in keyof T]: z.infer<T[K]["schema"]> };
}
