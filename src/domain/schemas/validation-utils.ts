/**
 * Cross-Interface Validation Utilities
 *
 * Validation utilities that work consistently across CLI, MCP, and API interfaces.
 * Provides standardized validation patterns and error handling.
 */
import { z, ZodError, ZodSchema } from "zod";
import { createErrorResponse, BaseErrorResponse } from "./common-schemas";

// ========================
// VALIDATION RESULT TYPES
// ========================

/**
 * Validation success result
 */
export interface ValidationSuccess<T> {
  success: true;
  data: T;
}

/**
 * Validation error result
 */
export interface ValidationError {
  success: false;
  error: string;
  details?: Record<string, any>;
  fieldErrors?: Record<string, string[]>;
}

/**
 * Validation result union type
 */
export type ValidationResult<T> = ValidationSuccess<T> | ValidationError;

// ========================
// CORE VALIDATION FUNCTIONS
// ========================

/**
 * Validates data against a Zod schema and returns a standardized result
 */
export function validateSchema<T>(
  schema: ZodSchema<T>,
  data: unknown,
  context?: string
): ValidationResult<T> {
  try {
    const validatedData = schema.parse(data);
    return {
      success: true,
      data: validatedData,
    };
  } catch (error) {
    if (error instanceof ZodError) {
      return {
        success: false,
        error: formatZodError(error, context),
        details: {
          zodError: error.format(),
          context,
        },
        fieldErrors: extractFieldErrors(error),
      };
    }
    
    return {
      success: false,
      error: `Validation error${context ? ` in ${context}` : ""}: ${error instanceof Error ? error.message : String(error)}`,
      details: { context },
    };
  }
}

/**
 * Validates data against a Zod schema with safe parsing (returns undefined on error)
 */
export function safeValidateSchema<T>(
  schema: ZodSchema<T>,
  data: unknown
): T | undefined {
  const result = schema.safeParse(data);
  return result.success ? result.data : undefined;
}

// ========================
// SPECIALIZED VALIDATION FUNCTIONS
// ========================

/**
 * Validates parameters for any interface operation
 */
export function validateOperationParameters<T>(
  schema: ZodSchema<T>,
  parameters: unknown,
  operation: string
): ValidationResult<T> {
  return validateSchema(schema, parameters, `${operation} parameters`);
}

/**
 * Validates and transforms CLI arguments to typed parameters
 */
export function validateCliArguments<T>(
  schema: ZodSchema<T>,
  args: Record<string, any>,
  command: string
): ValidationResult<T> {
  // Transform CLI-style arguments (kebab-case) to expected format
  const transformedArgs = transformCliArguments(args);
  return validateSchema(schema, transformedArgs, `CLI command '${command}'`);
}

/**
 * Validates MCP tool arguments
 */
export function validateMcpArguments<T>(
  schema: ZodSchema<T>,
  args: unknown,
  toolName: string
): ValidationResult<T> {
  return validateSchema(schema, args, `MCP tool '${toolName}'`);
}

/**
 * Validates API request body
 */
export function validateApiRequest<T>(
  schema: ZodSchema<T>,
  body: unknown,
  endpoint: string
): ValidationResult<T> {
  return validateSchema(schema, body, `API endpoint '${endpoint}'`);
}

// ========================
// ERROR FORMATTING FUNCTIONS
// ========================

/**
 * Formats a Zod error into a human-readable message
 */
export function formatZodError(error: ZodError, context?: string): string {
  const contextPrefix = context ? `${context}: ` : "";
  
  if (error.errors.length === 1) {
    const issue = error.errors[0];
    if (!issue) {
      return `${contextPrefix}Unknown validation error`;
    }
    const path = issue.path.length > 0 ? ` at '${issue.path.join(".")}'` : "";
    return `${contextPrefix}${issue.message}${path}`;
  }
  
  const errorList = error.errors
    .filter((issue) => issue !== undefined)
    .map((issue) => {
      const path = issue.path.length > 0 ? ` at '${issue.path.join(".")}'` : "";
      return `  - ${issue.message}${path}`;
    })
    .join("\n");
    
  return `${contextPrefix}Multiple validation errors:\n${errorList}`;
}

/**
 * Extracts field-specific errors from a Zod error
 */
export function extractFieldErrors(error: ZodError): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};
  
  for (const issue of error.errors) {
    const path = issue.path.join(".");
    const key = path || "_root";
    
    if (!fieldErrors[key]) {
      fieldErrors[key] = [];
    }
    
    fieldErrors[key].push(issue.message);
  }
  
  return fieldErrors;
}

// ========================
// UTILITY FUNCTIONS
// ========================

/**
 * Transforms CLI-style arguments (kebab-case flags) to camelCase
 */
export function transformCliArguments(args: Record<string, any>): Record<string, any> {
  const transformed: Record<string, any> = {};
  
  for (const [key, value] of Object.entries(args)) {
    // Convert kebab-case to camelCase
    const camelKey = key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    transformed[camelKey] = value;
  }
  
  return transformed;
}

/**
 * Creates a validation error response in the standard format
 */
export function createValidationErrorResponse(
  validation: ValidationError,
  operation?: string
): BaseErrorResponse {
  const errorMessage = operation 
    ? `Validation failed for ${operation}: ${validation.error}`
    : validation.error;
    
  return createErrorResponse(
    errorMessage,
    "VALIDATION_ERROR",
    {
      fieldErrors: validation.fieldErrors,
      details: validation.details,
    }
  );
}

/**
 * Checks if a validation result is successful
 */
export function isValidationSuccess<T>(
  result: ValidationResult<T>
): result is ValidationSuccess<T> {
  return result.success;
}

/**
 * Checks if a validation result is an error
 */
export function isValidationError<T>(
  result: ValidationResult<T>
): result is ValidationError {
  return !result.success;
}

// ========================
// ADDITIONAL EXPORTS
// ========================

// All types are already exported above as interfaces 
