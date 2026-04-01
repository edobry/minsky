/**
 * Shared Rules Commands
 *
 * Re-exports from the rules/ subdirectory for backwards compatibility.
 * Implementation is split across:
 *   - rules/rules-parameters.ts  — parameter definitions
 *   - rules/crud-commands.ts     — get, create, update, generate
 *   - rules/list-search-commands.ts — list, search, index-embeddings
 *   - rules/compile-migrate-commands.ts — compile, migrate
 *   - rules/selection-commands.ts — enable, disable, config, presets
 */
export { registerRulesCommands } from "./rules/index";
