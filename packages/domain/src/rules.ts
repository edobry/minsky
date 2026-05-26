/**
 * Rules module barrel re-export.
 *
 * All types, interfaces, and classes that were previously defined inline
 * have been moved to sub-modules under ./rules/.
 */
export * from "./rules/types";
export { RuleService } from "./rules/rule-service";
export type { RuleServiceFs } from "./rules/rule-service";
