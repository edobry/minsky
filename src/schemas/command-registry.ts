/**
 * Schema definitions for command registry operations
 * These schemas validate command definitions and execution context
 */
import { z } from "zod";

/**
 * Schema for command categories
 */
export const commandCategorySchema = z.enum([
  "CORE",
  "GIT", 
  "TASKS",
  "SESSION",
  "RULES",
  "INIT",
  "CONFIG",
  "DEBUG",
]);

/**
 * Schema for command execution context
 */
export const commandExecutionContextSchema = z.object({
  interface: z.string(),
  debug: z.boolean().optional(),
  format: z.string().optional(),
});

/**
 * Schema for command parameter definition
 */
export const commandParameterDefinitionSchema = z.object({
  schema: z.any(), // ZodTypeAny schema
  description: z.string().optional(),
  required: z.boolean(),
  defaultValue: z.any().optional(),
  cliHidden: z.boolean().optional(),
  mcpHidden: z.boolean().optional(),
});

/**
 * Schema for command parameter map
 */
export const commandParameterMapSchema = z.record(commandParameterDefinitionSchema);

/**
 * Schema for command definition
 */
export const commandDefinitionSchema = z.object({
  id: z.string().min(1),
  category: commandCategorySchema,
  name: z.string().min(1),
  description: z.string(),
  parameters: commandParameterMapSchema,
  execute: z.function(), // Command execution handler
});

/**
 * Schema for command registration options
 */
export const commandRegistrationOptionsSchema = z.object({
  allowOverwrite: z.boolean().optional(),
});

/**
 * Type definitions inferred from schemas
 */
export type CommandCategory = z.infer<typeof commandCategorySchema>;
export type CommandExecutionContext = z.infer<typeof commandExecutionContextSchema>;
export type CommandParameterDefinition = z.infer<typeof commandParameterDefinitionSchema>;
export type CommandParameterMap = z.infer<typeof commandParameterMapSchema>;
export type CommandDefinition = z.infer<typeof commandDefinitionSchema>;
export type CommandRegistrationOptions = z.infer<typeof commandRegistrationOptionsSchema>;

/**
 * Validation functions
 */
export function validateCommandCategory(data: unknown): CommandCategory {
  return commandCategorySchema.parse(data);
}

export function validateCommandExecutionContext(data: unknown): CommandExecutionContext {
  return commandExecutionContextSchema.parse(data);
}

export function validateCommandParameterDefinition(data: unknown): CommandParameterDefinition {
  return commandParameterDefinitionSchema.parse(data);
}

export function validateCommandParameterMap(data: unknown): CommandParameterMap {
  return commandParameterMapSchema.parse(data);
}

export function validateCommandDefinition(data: unknown): CommandDefinition {
  return commandDefinitionSchema.parse(data);
}

export function validateCommandRegistrationOptions(data: unknown): CommandRegistrationOptions {
  return commandRegistrationOptionsSchema.parse(data);
} 
