/**
 * Parameter Mapper for CLI Bridge
 *
 * Maps shared command parameters with Zod schemas to Commander.js options.
 * Handles validation, type conversions, and help text generation.
 */

import { Command, Option } from "commander";
import { z } from "zod";
import type { CommandParameterDefinition } from "../command-registry";
import { paramNameToFlag } from "../schema-bridge";
import { getErrorMessage } from "../../../errors/index";
import { formatZodError } from "../../../utils/zod-error-formatter";

/**
 * Configuration options for parameter mapping
 */
export interface ParameterMappingOptions {
  /** Parameter alias (shorthand) */
  alias?: string;
  /** Override the parameter description */
  description?: string;
  /** Override the default value */
  defaultValue?: any;
  /** Whether to hide this parameter from help */
  hidden?: boolean;
  /** Custom validation function */
  validator?: (value: any) => boolean;
  /** Custom error message for validation failures */
  errorMessage?: string;
  /** Custom parser for the value */
  parser?: (value: any) => any;
  /** Whether to handle this as a variadic parameter */
  variadic?: boolean;
  /** Whether to treat this as a CLI argument instead of option */
  asArgument?: boolean;
}

/**
 * Represents a parameter mapping with its definition and options
 */
export interface ParameterMapping {
  name: string;
  paramDef: CommandParameterDefinition;
  options: ParameterMappingOptions;
}

/**
 * Creates Commander.js options from parameter mappings
 */
export function createOptionsFromMappings(mappings: ParameterMapping[]): Option[] {
  return mappings.filter((mapping) => !mapping.options.asArgument).map(createOptionFromMapping);
}

/**
 * Adds Commander.js arguments from parameter mappings
 */
export function addArgumentsFromMappings(command: Command, mappings: ParameterMapping[]): Command {
  const argumentMappings = mappings.filter((mapping) => mapping.options.asArgument);

  argumentMappings.forEach((mapping) => {
    const { name, paramDef, options } = mapping;

    // Format argument name
    const argName = formatArgumentName(name, paramDef.required, options.variadic);

    // Add argument to command
    if (options.variadic) {
      command.argument(argName, options.description || paramDef.description || "");
    } else {
      command.argument(argName, options.description || paramDef.description || "");
    }

    // Add custom parser if provided
    if (options.parser) {
      // Note: Commander.js doesn't have a direct way to add parsers to arguments
      // This would need to be handled in the action function
    }
  });

  return command;
}

/**
 * Creates a Commander.js Option from a parameter mapping
 */
function createOptionFromMapping(mapping: ParameterMapping): Option {
  const { name, paramDef, options } = mapping;

  // Get schema type for proper option definition
  const schemaType = getZodSchemaType(paramDef.schema);

  // Format option flag
  const flag = formatOptionFlag(name, options.alias, schemaType);

  // Create the option
  const option = new Option(flag, options.description || paramDef.description || "");

  // Apply additional configuration
  if (options.hidden) {
    option.hideHelp();
  }

  if (paramDef.defaultValue !== undefined || options.defaultValue !== undefined) {
    option.default(options.defaultValue ?? paramDef.defaultValue);
  }

  // Add proper type handling based on schema
  addTypeHandlingToOption(option, schemaType, options.parser);

  return option;
}

/**
 * Format a Commander option flag
 */
function formatOptionFlag(name: string, alias?: string, schemaType?: string): string {
  let flag = "";

  // Add alias if provided
  if (alias) {
    flag += `-${alias}, `;
  }

  // Add main flag with kebab-case conversion
  flag += `--${paramNameToFlag(name)}`;

  // Add value placeholder for non-boolean types
  if (schemaType !== "boolean") {
    flag += ` <${schemaType || "value"}>`;
  }

  return flag;
}

/**
 * Format an argument name based on requirements
 */
function formatArgumentName(name: string, required: boolean, variadic?: boolean): string {
  let argName = name;

  // Make optional arguments appear in square brackets
  if (!required) {
    argName = `[${argName}]`;
  } else {
    argName = `<${argName}>`;
  }

  // Add ellipsis for variadic arguments
  if (variadic) {
    argName += "...";
  }

  return argName;
}

/**
 * Add type-specific handling to a Commander option
 */
function addTypeHandlingToOption(
  option: Option,
  schemaType?: string,
  customParser?: (value: any) => any
): Option {
  // If a custom parser is provided, use it
  if (customParser) {
    return option.argParser(customParser);
  }

  // Otherwise use schema type to determine parsing
  switch (schemaType) {
  case "number":
    return option.argParser((value) => {
      const num = Number(value);
      if (isNaN(num)) {
        throw new Error("Option requires a number value");
      }
      return num;
    });

  case "boolean":
    return option;

  case "array":
    return option.argParser((value) => value.split(",").map((v) => v.trim()));

  default:
    return option;
  }
}

/**
 * Try to determine the Zod schema type for appropriate option handling
 */
function getZodSchemaType(schema: z.ZodTypeAny): string | undefined {
  // Handle primitive types
  if (schema instanceof z.ZodString) return "string";
  if (schema instanceof z.ZodNumber) return "number";
  if (schema instanceof z.ZodBoolean) return "boolean";

  // Handle arrays
  if (schema instanceof z.ZodArray) return "array";

  // Handle optional types and nullable types (unwrap and check inner type)
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return getZodSchemaType(schema.unwrap());
  }

  // Handle default types (access inner type differently)
  if (schema instanceof z.ZodDefault) {
    return getZodSchemaType(schema._def.innerType);
  }

  // Handle enums
  if (schema instanceof z.ZodEnum) return "string";

  // Default to string for other types
  return "string";
}

/**
 * Create parameter mappings from a CommandParameterMap
 */
export function createParameterMappings(
  parameters: Record<string, CommandParameterDefinition>,
  customOptions: Record<string, ParameterMappingOptions> = {}
): ParameterMapping[] {
  return Object.entries(parameters).map(([name, paramDef]) => ({
    name,
    paramDef,
    options: {
      // Apply default options
      hidden: paramDef.cliHidden,

      // Override with custom options if available
      ...customOptions[name],
    },
  }));
}

/**
 * Validates and normalizes CLI arguments to match shared command parameter expectations
 */
export function normalizeCliParameters(
  parametersSchema: Record<string, CommandParameterDefinition>,
  cliParameters: Record<string, any>
): Record<string, any> {
  const result: Record<string, any> = {};

  // Process each parameter
  for (const [paramName, paramDef] of Object.entries(parametersSchema)) {
    const rawValue = cliParameters[paramName];

    // Handle undefined values
    if (rawValue === undefined) {
      // Use default value if available
      if (paramDef.defaultValue !== undefined) {
        result[paramName] = paramDef.defaultValue;
      }
      // Skip optional parameters
      if (!paramDef.required) {
        continue;
      }
      // Error for required parameters without default
      throw new Error(`Required parameter '${paramName}' is missing`);
    } else {
      // Parse and validate the value
      try {
        const parsedValue = paramDef.schema.parse(rawValue);
        result[paramName] = parsedValue;
      } catch (error) {
        // Use user-friendly error formatting for Zod validation errors
        if (error instanceof z.ZodError) {
          const userFriendlyMessage = formatZodError(error, paramName);
          throw new Error(`Invalid value for parameter '${paramName}': ${userFriendlyMessage}`);
        } else {
          throw new Error(`Invalid value for parameter '${paramName}': ${getErrorMessage(error as any)}`);
        }
      }
    }
  }

  return result;
}
