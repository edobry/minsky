/**
 * Rules Operations Module
 *
 * Exports for all modularized rule operation components.
 * Part of the modularization effort from rules.ts.
 */

// Base operation infrastructure
export {
  BaseRuleOperation,
  RuleOperationRegistry,
  ruleOperationRegistry,
} from "./base-rule-operation";
export type {
  RuleOperationDependencies,
  RuleOperationFactory,
  BaseRuleOperationParams,
} from "./base-rule-operation";

// File operations
export {
  ReadRuleFileOperation,
  WriteRuleFileOperation,
  ListRulesDirectoryOperation,
  createReadRuleFileOperation,
  createWriteRuleFileOperation,
  createListRulesDirectoryOperation,
} from "./file-operations";

// Core operations
export {
  ListRulesOperation,
  GetRuleOperation,
  CreateRuleOperation,
  UpdateRuleOperation,
  SearchRulesOperation,
  createListRulesOperation,
  createGetRuleOperation,
  createCreateRuleOperation,
  createUpdateRuleOperation,
  createSearchRulesOperation,
} from "./core-operations";

// Import for local use in createAllRuleOperations
import {
  createListRulesOperation,
  createGetRuleOperation,
  createCreateRuleOperation,
  createUpdateRuleOperation,
  createSearchRulesOperation,
} from "./core-operations";
import {
  createReadRuleFileOperation,
  createWriteRuleFileOperation,
  createListRulesDirectoryOperation,
} from "./file-operations";
import { RuleOperationRegistry } from "./base-rule-operation";

// Factory for creating all rule operations
export function createAllRuleOperations(deps: RuleOperationDependencies) {
  return {
    // Core operations
    list: createListRulesOperation(deps),
    get: createGetRuleOperation(deps),
    create: createCreateRuleOperation(deps),
    update: createUpdateRuleOperation(deps),
    search: createSearchRulesOperation(deps),

    // File operations
    readFile: createReadRuleFileOperation(deps),
    writeFile: createWriteRuleFileOperation(deps),
    listDirectory: createListRulesDirectoryOperation(deps),
  };
}

// Registry setup function
export function setupRuleOperationRegistry(deps: RuleOperationDependencies): RuleOperationRegistry {
  const registry = new RuleOperationRegistry();
  const operations = createAllRuleOperations(deps);

  // Register all operations
  registry.register("list", operations.list);
  registry.register("get", operations.get);
  registry.register("create", operations.create);
  registry.register("update", operations.update);
  registry.register("search", operations.search);
  registry.register("readFile", operations.readFile);
  registry.register("writeFile", operations.writeFile);
  registry.register("listDirectory", operations.listDirectory);

  return registry;
}
