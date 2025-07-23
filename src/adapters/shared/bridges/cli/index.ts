/**
 * CLI Bridge Components
 * 
 * Exports for all modularized CLI bridge components.
 * Part of the modularization effort from cli-bridge.ts.
 */

// Core components
export { CommandCustomizationManager, commandCustomizationManager } from "./command-customization-manager";
export { CommandGeneratorCore, createCommandGenerator } from "./command-generator-core";
export { ParameterProcessor, parameterProcessor } from "./parameter-processor";
export { 
  DefaultCommandResultFormatter, 
  EnhancedCommandResultFormatter,
  defaultResultFormatter,
  enhancedResultFormatter
} from "./result-formatter";
export { CategoryCommandHandler, createCategoryCommandHandler } from "./category-command-handler";

// Type exports
export type { 
  CliCommandOptions, 
  CategoryCommandOptions,
  ParameterMappingOptions 
} from "./command-customization-manager";
export type { 
  CliExecutionContext, 
  CommandGeneratorDependencies 
} from "./command-generator-core";
export type { CommandResultFormatter } from "./result-formatter";
export type { CategoryCommandHandlerDependencies } from "./category-command-handler";

// Re-export parameter mapping utilities
export {
  type ParameterMapping,
  type ParameterMappingOptions as ParameterMapperOptions,
  createParameterMappings,
  createOptionsFromMappings,
  addArgumentsFromMappings,
  normalizeCliParameters,
} from "../parameter-mapper";