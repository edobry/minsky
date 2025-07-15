/**
 * Utility functions for formatting Zod validation errors into user-friendly messages
 */
import { ZodError, ZodIssue } from "zod";
import { createValidationErrorMessage } from "../errors/message-templates";
import { TASK_STATUS_VALUES } from "../domain/tasks/taskConstants";

/**
 * Format a Zod validation error into a user-friendly message
 * @param error The Zod validation error
 * @param context Optional context for the error
 * @returns User-friendly error message
 */
export function formatZodError(error: ZodError, context?: string): string {
  if (error.issues.length === 0) {
    return "Invalid input provided";
  }

  // Handle single issue
  if (error.issues.length === 1) {
    return formatSingleZodIssue(error.issues[0]!, context);
  }

  // Handle multiple issues
  const formattedIssues = error.issues.map(issue => formatSingleZodIssue(issue, context));
  return `Multiple validation errors:\n${formattedIssues.map(msg => `• ${msg}`).join("\n")}`;
}

/**
 * Format a single Zod issue into a user-friendly message
 * @param issue The Zod validation issue
 * @param context Optional context for the error
 * @returns User-friendly error message
 */
function formatSingleZodIssue(issue: ZodIssue, _context?: string): string {
  const fieldPath = issue.path.join(".");
  const fieldName = fieldPath || "input";

  switch (issue.code) {
  case "invalid_enum_value":
    return formatEnumError(issue, fieldName);
  
  case "invalid_type":
    return formatTypeError(issue, fieldName);
  
  case "too_small":
    return formatTooSmallError(issue, fieldName);
  
  case "too_big":
    return formatTooBigError(issue, fieldName);
  
  case "invalid_string":
    return formatStringError(issue, fieldName);
  
  case "custom":
    return issue.message || `Invalid ${fieldName}`;
  
  default:
    return issue.message || `Invalid ${fieldName}`;
  }
}

/**
 * Format enum validation errors with available options
 */
function formatEnumError(issue: ZodIssue, fieldName: string): string {
  // Type guard and cast to enum issue type
  if (issue.code !== "invalid_enum_value") {
    return `Invalid ${fieldName}`;
  }
  
  const enumIssue = issue as unknown; // Cast to access enum-specific properties
  const value = enumIssue.received;
  const options = enumIssue.options as string[];
  
  // Special handling for task status enum
  if (fieldName === "status" && isTaskStatusEnum(options)) {
    return createValidationErrorMessage(
      "status",
      String(value),
      TASK_STATUS_VALUES,
      [
        { label: "Field", value: fieldName },
        { label: "Provided", value: String(value) }
      ]
    );
  }
  
  // Generic enum error
  return createValidationErrorMessage(
    fieldName,
    String(value),
    options,
    [
      { label: "Field", value: fieldName },
      { label: "Provided", value: String(value) }
    ]
  );
}

/**
 * Format type validation errors
 */
function formatTypeError(issue: ZodIssue, fieldName: string): string {
  if (issue.code !== "invalid_type") {
    return `Invalid ${fieldName}`;
  }
  
  const typeIssue = issue as unknown; // Cast to access type-specific properties
  const expectedType = typeIssue.expected;
  const receivedType = typeIssue.received;
  
  return `Invalid ${fieldName}: expected ${expectedType}, received ${receivedType}`;
}

/**
 * Format "too small" validation errors
 */
function formatTooSmallError(issue: ZodIssue, fieldName: string): string {
  if (issue.code !== "too_small") {
    return `${fieldName} is too small`;
  }
  
  const sizeIssue = issue as unknown; // Cast to access size-specific properties
  const minimum = sizeIssue.minimum;
  const type = sizeIssue.type;
  
  if (type === "string") {
    return `${fieldName} must be at least ${minimum} characters long`;
  } else if (type === "number") {
    return `${fieldName} must be at least ${minimum}`;
  } else if (type === "array") {
    return `${fieldName} must contain at least ${minimum} item(s)`;
  }
  
  return `${fieldName} is too small`;
}

/**
 * Format "too big" validation errors
 */
function formatTooBigError(issue: ZodIssue, fieldName: string): string {
  if (issue.code !== "too_big") {
    return `${fieldName} is too big`;
  }
  
  const sizeIssue = issue as unknown; // Cast to access size-specific properties
  const maximum = sizeIssue.maximum;
  const type = sizeIssue.type;
  
  if (type === "string") {
    return `${fieldName} must be at most ${maximum} characters long`;
  } else if (type === "number") {
    return `${fieldName} must be at most ${maximum}`;
  } else if (type === "array") {
    return `${fieldName} must contain at most ${maximum} item(s)`;
  }
  
  return `${fieldName} is too big`;
}

/**
 * Format string validation errors
 */
function formatStringError(issue: ZodIssue, fieldName: string): string {
  if (issue.code !== "invalid_string") {
    return `${fieldName} format is invalid`;
  }
  
  const stringIssue = issue as unknown; // Cast to access string-specific properties
  const validation = stringIssue.validation;
  
  if (validation === "email") {
    return `${fieldName} must be a valid email address`;
  } else if (validation === "url") {
    return `${fieldName} must be a valid URL`;
  } else if (validation === "uuid") {
    return `${fieldName} must be a valid UUID`;
  }
  
  return `${fieldName} format is invalid`;
}

/**
 * Check if the enum options are task status values
 */
function isTaskStatusEnum(options: string[]): boolean {
  return options.length === TASK_STATUS_VALUES.length &&
         options.every(option => TASK_STATUS_VALUES.includes(option));
}

/**
 * Create a formatted error message for common validation scenarios
 * @param operation The operation being performed (e.g., "setting task status")
 * @param error The Zod validation error
 * @returns Formatted error message
 */
export function createFormattedValidationError(operation: string, error: ZodError): string {
  const formattedError = formatZodError(error, operation);
  return `Invalid parameters for ${operation}:\n${formattedError}`;
} 
