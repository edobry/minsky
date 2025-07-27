/**
 * Base Git Operation
 *
 * Abstract base class providing common functionality for all git operations.
 * Extracted from git.ts as part of modularization effort.
 */
import { z } from "zod";
import { ValidationError } from "../../../errors/index";
import { log } from "../../../utils/logger";
import { getErrorMessage } from "../../../errors/index";
import { type GitServiceInterface } from "../types";

/**
 * Common dependencies for git operations
 */
export interface GitOperationDependencies {
  createGitService: (options?: { baseDir?: string }) => GitServiceInterface;
}

/**
 * Common parameters for git operations
 */
export interface BaseGitOperationParams {
  session?: string;
  repo?: string;
  debug?: boolean;
}

/**
 * Abstract base class for git operations
 */
export abstract class BaseGitOperation<TParams, TResult> {
  constructor(protected deps: GitOperationDependencies) {}

  /**
   * Get the Zod schema for validating parameters (optional, can return null for no validation)
   */
  getSchema(): z.ZodSchema<TParams> | null {
    return null; // Override in subclasses if validation needed
  }

  /**
   * Execute the operation with validated parameters
   */
  abstract executeOperation(params: TParams, gitService: GitServiceInterface): Promise<TResult>;

  /**
   * Get the operation name (for error messages)
   */
  abstract getOperationName(): string;

  /**
   * Execute the operation with full validation and error handling
   */
  async execute(params: TParams): Promise<TResult> {
    try {
      // Validate parameters if schema provided
      const validParams = this.validateParams(params);

      // Create git service
      const gitService = this.deps.createGitService();

      // Execute the operation
      return await this.executeOperation(validParams, gitService);
    } catch (error) {
      // Enhanced error logging with operation context
      this.logError(params, error);

      if (error instanceof z.ZodError) {
        throw new ValidationError(
          `Invalid parameters for ${this.getOperationName()}`,
          error.format(),
          error
        );
      }
      throw error;
    }
  }

  /**
   * Validate parameters using schema if provided
   */
  protected validateParams(params: TParams): TParams {
    const schema = this.getSchema();
    if (schema) {
      return schema.parse(params);
    }
    return params; // No validation if no schema
  }

  /**
   * Log operation errors with consistent format
   */
  protected logError(params: TParams, error: any): void {
    const baseParams = params as BaseGitOperationParams;
    log.error(`Error in ${this.getOperationName()}`, {
      session: baseParams.session,
      repo: baseParams.repo,
      debug: baseParams.debug,
      error: getErrorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
      operation: this.getOperationName(),
      ...this.getAdditionalLogContext(params),
    });
  }

  /**
   * Get additional context for error logging (override in subclasses)
   */
  protected getAdditionalLogContext(params: TParams): Record<string, any> {
    return {};
  }

  /**
   * Create success result with consistent structure
   */
  protected createSuccessResult(
    data: any,
    message?: string,
    additionalData: Record<string, any> = {}
  ): any {
    return {
      success: true,
      ...data,
      ...(message && { message }),
      ...additionalData,
    };
  }

  /**
   * Create error result with consistent structure
   */
  protected createErrorResult(
    error: string | Error,
    additionalData: Record<string, any> = {}
  ): any {
    return {
      success: false,
      error: typeof error === "string" ? error : getErrorMessage(error),
      ...additionalData,
    };
  }
}

/**
 * Factory type for creating git operations
 */
export type GitOperationFactory<TParams, TResult> = (
  deps?: GitOperationDependencies
) => BaseGitOperation<TParams, TResult>;

/**
 * Git operation registry for managing operation instances
 */
export class GitOperationRegistry {
  private operations = new Map<string, BaseGitOperation<any, any>>();

  /**
   * Register a git operation
   */
  register<TParams, TResult>(name: string, operation: BaseGitOperation<TParams, TResult>): void {
    this.operations.set(name, operation);
  }

  /**
   * Get a git operation by name
   */
  get<TParams, TResult>(name: string): BaseGitOperation<TParams, TResult> | undefined {
    return this.operations.get(name);
  }

  /**
   * Execute an operation by name
   */
  async execute<TParams, TResult>(name: string, params: TParams): Promise<TResult> {
    const operation = this.get<TParams, TResult>(name);
    if (!operation) {
      throw new ValidationError(`Git operation '${name}' not found`);
    }
    return await operation.execute(params);
  }

  /**
   * Get all registered operation names
   */
  getOperationNames(): string[] {
    return Array.from(this.operations.keys());
  }

  /**
   * Clear all operations (useful for testing)
   */
  clear(): void {
    this.operations.clear();
  }
}

/**
 * Default git operation registry instance
 */
export const gitOperationRegistry = new GitOperationRegistry();
