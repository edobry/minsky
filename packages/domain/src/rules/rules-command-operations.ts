/**
 * Rules Command Operations
 *
 * Barrel re-export — sub-modules contain the actual implementations:
 *   - operations/types.ts              — all interfaces and type definitions
 *   - operations/config-operations.ts  — readRulesSelectionConfig,
 *                                        writeRulesSelectionConfig, enableRule,
 *                                        disableRule, getRulesConfig, getRulesPresets
 *   - operations/crud-operations.ts    — listRulesFiltered, compileRules, getRule,
 *                                        generateRules, createRule, updateRule
 *   - operations/migration-operations.ts — migrateRules, indexRuleEmbeddings,
 *                                          searchRulesEnhanced
 */

export type {
  RulesSelectionConfig,
  MigrateRulesOptions,
  MigrateRulesResult,
  IndexEmbeddingsOptions,
  IndexEmbeddingsResult,
  EnhancedRuleSearchResult,
  SearchRulesEnhancedOptions,
  RulesConfigResult,
  RulesPresetsResult,
  ListRulesOptions,
  ListRulesResult,
  CompileRulesOptions,
  CompileRulesResult,
  GetRuleOptions,
  GetRuleResult,
  GenerateRulesOptions,
  GenerateRulesResult,
  CreateRuleOptions,
  CreateRuleResult,
  UpdateRuleOptions,
  UpdateRuleResult,
} from "./operations/types";

export {
  readRulesSelectionConfig,
  writeRulesSelectionConfig,
  enableRule,
  disableRule,
  getRulesConfig,
  getRulesPresets,
} from "./operations/config-operations";

export {
  listRulesFiltered,
  compileRules,
  getRule,
  generateRules,
  createRule,
  updateRule,
} from "./operations/crud-operations";

export {
  migrateRules,
  indexRuleEmbeddings,
  searchRulesEnhanced,
} from "./operations/migration-operations";
