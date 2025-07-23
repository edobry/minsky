/**
 * Base Rule Operation
 * 
 * Abstract base class providing common functionality for all rule operations.
 * Extracted from rules.ts as part of modularization effort.
 */
import { ValidationError } from "../../../errors/index";
import { log } from "../../../utils/logger";
import { join } from "path";
import { type RuleFormat, type RuleMeta } from "../types";

/**
 * Common dependencies for rule operations
 */
export interface RuleOperationDependencies {
  workspacePath: string;
  // Additional dependencies can be injected here
}

/**
 * Common parameters for rule operations
 */
export interface BaseRuleOperationParams {
  format?: RuleFormat;
  debug?: boolean;
  workspacePath?: string;
}

/**
 * Abstract base class for rule operations
 */
export abstract class BaseRuleOperation<TParams, TResult> {
  constructor(
    protected deps: RuleOperationDependencies
  ) {}

  /**
   * Get the operation name (for logging and debugging)
   */
  abstract getOperationName(): string;

  /**
   * Execute the operation with validated parameters
   */
  abstract executeOperation(params: TParams): Promise<TResult>;

  /**
   * Execute the operation with full validation and error handling
   */
  async execute(params: TParams): Promise<TResult> {
    try {
      log.debug(`Executing ${this.getOperationName()} operation`, { 
        operation: this.getOperationName(),
        workspacePath: this.deps.workspacePath,
        ...this.getAdditionalLogContext(params),
      });

      // Execute the operation
      const result = await this.executeOperation(params);

      return result;
    } catch (error) {
      // Enhanced error logging with operation context
      this.logError(params, error);
      throw error;
    }
  }

  /**
   * Log operation errors with consistent format
   */
  protected logError(params: TParams, error: any): void {
    log.error(`Error in ${this.getOperationName()}`, {
      operation: this.getOperationName(),
      workspacePath: this.deps.workspacePath,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
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
   * Get the rule directory path for a given format
   */
  protected getRuleDirPath(format: RuleFormat): string {
    return join(this.deps.workspacePath, format === "cursor" ? ".cursor/rules" : ".ai/rules");
  }

  /**
   * Get the full path for a rule file
   */
  protected getRuleFilePath(id: string, format: RuleFormat): string {
    return join(this.getRuleDirPath(format), `${id}.mdc`);
  }

  /**
   * Remove file extension from rule ID if present
   */
  protected normalizeRuleId(id: string): string {
    return id.replace(/\\.mdc$/, "");
  }

  /**
   * Get all formats to search when format is not specified
   */
  protected getFormatsToSearch(requestedFormat?: RuleFormat): RuleFormat[] {
    return requestedFormat ? [requestedFormat] : ["cursor", "generic"];
  }

  /**
   * Clean metadata object by removing undefined values
   */
  protected cleanMetadata(meta: RuleMeta): RuleMeta {
    const cleanMeta: RuleMeta = {};
    Object.entries(meta).forEach(([key, value]) => {
      if (value !== undefined) {
        cleanMeta[key] = value;
      }
    });
    return cleanMeta;
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
      error: typeof error === "string" ? error : error.message,
      ...additionalData,
    };
  }
}

/**
 * Factory type for creating rule operations
 */
export type RuleOperationFactory<TParams, TResult> = (
  deps: RuleOperationDependencies
) => BaseRuleOperation<TParams, TResult>;

/**
 * Rule operation registry for managing operation instances
 */
export class RuleOperationRegistry {
  private operations = new Map<string, BaseRuleOperation<any, any>>();

  /**
   * Register a rule operation
   */
  register<TParams, TResult>(
    name: string,
    operation: BaseRuleOperation<TParams, TResult>
  ): void {
    this.operations.set(name, operation);
  }

  /**
   * Get a rule operation by name
   */
  get<TParams, TResult>(name: string): BaseRuleOperation<TParams, TResult> | undefined {
    return this.operations.get(name);
  }

  /**
   * Execute an operation by name
   */
  async execute<TParams, TResult>(
    name: string,
    params: TParams
  ): Promise<TResult> {
    const operation = this.get<TParams, TResult>(name);
    if (!operation) {
      throw new ValidationError(`Rule operation '${name}' not found`);
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
 * Default rule operation registry instance
 */
export const ruleOperationRegistry = new RuleOperationRegistry();