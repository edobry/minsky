/**
 * CLI Parameter Processor
 *
 * Handles parameter mapping, extraction, and command setup for CLI commands.
 * Extracted from cli-bridge.ts as part of modularization effort.
 */
import { Command } from "commander";
import { log } from "../../../../utils/logger";
import {
  type ParameterMapping,
  createParameterMappings,
  createOptionsFromMappings,
  addArgumentsFromMappings,
} from "../parameter-mapper";
import { type SharedCommand } from "../../command-registry";
import { type CliCommandOptions } from "./command-customization-manager";

/**
 * Handles parameter processing for CLI commands
 */
export class ParameterProcessor {
  /**
   * Set up command parameters (arguments and options)
   */
  setupCommandParameters(
    command: Command,
    commandDef: SharedCommand,
    options: CliCommandOptions
  ): void {
    // Create parameter mappings
    log.debug("Creating parameter mappings");
    const mappings = this.createCommandParameterMappings(commandDef, options);
    log.debug(`Parameter mappings created: ${mappings.length}`);

    // Add arguments to the command
    addArgumentsFromMappings(command, mappings);

    // Add options to the command
    createOptionsFromMappings(mappings).forEach((option) => {
      command.addOption(option);
    });
  }

  /**
   * Create parameter mappings for a command
   */
  createCommandParameterMappings(
    commandDef: SharedCommand,
    options: CliCommandOptions
  ): ParameterMapping[] {
    const mappings = createParameterMappings(commandDef.parameters || {}, options.parameters || {});

    // If automatic argument generation is enabled
    if (options.useFirstRequiredParamAsArgument && !options.forceOptions) {
      // Find the first required parameter to use as an argument
      const firstRequiredIndex = mappings.findIndex((mapping) => mapping.paramDef.required);

      if (firstRequiredIndex >= 0 && mappings[firstRequiredIndex]) {
        // Mark it as an argument
        mappings[firstRequiredIndex].options.asArgument = true;
      }
    }

    return mappings;
  }

  /**
   * Extract raw parameters from CLI options and arguments
   */
  extractRawParameters(
    parameters: Record<string, any>,
    options: Record<string, any>,
    positionalArgs: any[],
    commandDef: SharedCommand,
    commandOptions: CliCommandOptions
  ): Record<string, any> {
    const result = { ...options };

    // Create mappings to understand argument structure
    const mappings = this.createCommandParameterMappings(commandDef, commandOptions);

    // Map positional arguments to parameter names
    const argumentMappings = mappings
      .filter((mapping) => mapping.options.asArgument)
      .sort((a, b) => {
        // Required arguments come first
        if (a.paramDef.required && !b.paramDef.required) return -1;
        if (!a.paramDef.required && b.paramDef.required) return 1;
        return 0;
      });

    // Assign positional arguments to their corresponding parameters
    argumentMappings.forEach((mapping, index) => {
      if (index < positionalArgs.length) {
        result[mapping.name] = positionalArgs[index];
      }
    });

    return result;
  }

  /**
   * Validate parameters against command definition
   */
  validateParameters(
    parameters: Record<string, any>,
    commandDef: SharedCommand
  ): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];
    const paramDefs = commandDef.parameters || {};

    // Check required parameters
    Object.entries(paramDefs).forEach(([name, paramDef]) => {
      if (paramDef.required && (parameters[name] === undefined || parameters[name] === null)) {
        errors.push(`Required parameter '${name}' is missing`);
      }
    });

    // Check parameter types (basic validation)
    Object.entries(parameters).forEach(([name, value]) => {
      const paramDef = paramDefs[name];
      if (paramDef && value !== undefined && value !== null) {
        if (paramDef.type === "number" && typeof value !== "number") {
          // Try to convert string to number
          const numValue = Number(value);
          if (isNaN(numValue)) {
            errors.push(`Parameter '${name}' should be a number, got: ${typeof value}`);
          } else {
            // Update the value in place
            parameters[name] = numValue;
          }
        } else if (paramDef.type === "boolean" && typeof value !== "boolean") {
          // Try to convert string to boolean
          if (typeof value === "string") {
            if (value.toLowerCase() === "true" || value === "1") {
              parameters[name] = true;
            } else if (value.toLowerCase() === "false" || value === "0") {
              parameters[name] = false;
            } else {
              errors.push(`Parameter '${name}' should be a boolean, got: ${value}`);
            }
          } else {
            errors.push(`Parameter '${name}' should be a boolean, got: ${typeof value}`);
          }
        }
      }
    });

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Apply parameter defaults
   */
  applyParameterDefaults(
    parameters: Record<string, any>,
    commandDef: SharedCommand
  ): Record<string, any> {
    const result = { ...parameters };
    const paramDefs = commandDef.parameters || {};

    Object.entries(paramDefs).forEach(([name, paramDef]) => {
      if (result[name] === undefined && paramDef.defaultValue !== undefined) {
        result[name] = paramDef.defaultValue;
      }
    });

    return result;
  }

  /**
   * Get parameter help text
   */
  getParameterHelpText(commandDef: SharedCommand): string[] {
    const helpLines: string[] = [];
    const paramDefs = commandDef.parameters || {};

    Object.entries(paramDefs).forEach(([name, paramDef]) => {
      const requiredText = paramDef.required ? " (required)" : "";
      const defaultText =
        paramDef.defaultValue !== undefined ? ` (default: ${paramDef.defaultValue})` : "";

      helpLines.push(
        `  ${name}: ${paramDef.description || "No description"}${requiredText}${defaultText}`
      );
    });

    return helpLines;
  }
}

/**
 * Default instance for parameter processing
 */
export const parameterProcessor = new ParameterProcessor();
