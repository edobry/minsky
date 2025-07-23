/**
 * Modular Rules Service
 *
 * Lightweight orchestration layer that coordinates the extracted rule operation components.
 * This provides backward-compatible RuleService functionality using the new modular architecture.
 */
import {
  createAllRuleOperations,
  setupRuleOperationRegistry,
  type RuleOperationDependencies,
  type RuleOperationRegistry,
} from "./operations";
import {
  type Rule,
  type RuleMeta,
  type RuleOptions,
  type CreateRuleOptions,
  type UpdateRuleOptions,
  type SearchRuleOptions,
} from "./types";

/**
 * Modular Rules Service Manager
 *
 * Manages rule operations using the Strategy Pattern with dependency injection.
 * Provides a clean interface for executing rule operations.
 */
export class ModularRulesService {
  private operations: ReturnType<typeof createAllRuleOperations>;
  private operationRegistry: RuleOperationRegistry;

  constructor(workspacePath: string, additionalDeps: Partial<RuleOperationDependencies> = {}) {
    const deps: RuleOperationDependencies = {
      workspacePath,
      ...additionalDeps,
    };

    this.operations = createAllRuleOperations(deps);
    this.operationRegistry = setupRuleOperationRegistry(deps);
  }

  /**
   * List all rules in the workspace
   */
  async listRules(options: RuleOptions = {}): Promise<Rule[]> {
    return await this.operations.list.execute(options);
  }

  /**
   * Get a specific rule by id
   */
  async getRule(id: string, options: RuleOptions = {}): Promise<Rule> {
    return await this.operations.get.execute({ id, options });
  }

  /**
   * Create a new rule
   */
  async createRule(
    id: string,
    content: string,
    meta: RuleMeta,
    options: CreateRuleOptions = {}
  ): Promise<Rule> {
    return await this.operations.create.execute({ id, content, meta, options });
  }

  /**
   * Update an existing rule
   */
  async updateRule(
    id: string,
    options: UpdateRuleOptions,
    ruleOptions: RuleOptions = {}
  ): Promise<Rule> {
    return await this.operations.update.execute({ id, options, ruleOptions });
  }

  /**
   * Search for rules by content or metadata
   */
  async searchRules(options: SearchRuleOptions = {}): Promise<Rule[]> {
    return await this.operations.search.execute(options);
  }

  /**
   * Get the operation registry
   */
  getOperationRegistry(): RuleOperationRegistry {
    return this.operationRegistry;
  }

  /**
   * Get direct access to operations (for advanced usage)
   */
  getOperations() {
    return this.operations;
  }

  /**
   * Get available operation names
   */
  getOperationNames(): string[] {
    return this.operationRegistry.getOperationNames();
  }
}

/**
 * Factory function to create a modular rules service
 */
export function createModularRulesService(
  workspacePath: string,
  additionalDeps?: Partial<RuleOperationDependencies>
): ModularRulesService {
  return new ModularRulesService(workspacePath, additionalDeps);
}

// Export all rule operation components for direct access
export * from "./operations";
export * from "./types";

// Export for migration path
export { ModularRulesService as RulesService };
export { createModularRulesService as createRulesService };
