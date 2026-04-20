/**
 * @minsky/definitions — TypeScript-first authoring for behavioral artifacts.
 *
 * All skills, rules, and agents are authored as TypeScript modules
 * using defineSkill, defineRule, and defineAgent, then compiled
 * to harness-specific output formats.
 */

export type {
  AgentDefinition,
  AgentModel,
  AgentPermissionMode,
  RuleDefinition,
  SkillDefinition,
} from "./types";

export { defineAgent, defineRule, defineSkill, loadMarkdown } from "./factories";

export { agentDefinitionSchema, ruleDefinitionSchema, skillDefinitionSchema } from "./schemas";
