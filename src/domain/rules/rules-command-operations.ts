/**
 * Rules Command Operations
 *
 * Barrel re-export of all rules command operation modules.
 * Split by concern into focused files:
 *   - rules-command-types.ts        — shared interfaces / types
 *   - rules-command-config-ops.ts   — selection config, enable/disable, presets
 *   - rules-command-migration-ops.ts — migration, embeddings, search
 *   - rules-command-crud-ops.ts     — list, get, create, update, compile, generate
 */

export type {
  RulesSelectionConfig,
  RulesConfigResult,
  RulesPresetsResult,
  MigrateRulesOptions,
  MigrateRulesResult,
  IndexEmbeddingsOptions,
  IndexEmbeddingsResult,
  EnhancedRuleSearchResult,
  SearchRulesEnhancedOptions,
  ListRulesOptions,
  ListRulesResult,
  CompileRulesOptions,
  CompileRulesResult,
  GetRuleOptions,
  GetRuleResult,
  CreateRuleOptions,
  CreateRuleResult,
  UpdateRuleOptions,
  UpdateRuleResult,
  GenerateRulesOptions,
  GenerateRulesResult,
} from "./rules-command-types";

export {
  readRulesSelectionConfig,
  writeRulesSelectionConfig,
  enableRule,
  disableRule,
  getRulesConfig,
  getRulesPresets,
} from "./rules-command-config-ops";

export {
  migrateRules,
  indexRuleEmbeddings,
  searchRulesEnhanced,
} from "./rules-command-migration-ops";

export {
  listRulesFiltered,
  compileRules,
  getRule,
  generateRules,
  createRule,
  updateRule,
} from "./rules-command-crud-ops";
