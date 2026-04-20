/**
 * Factory functions for creating validated definitions.
 *
 * These provide compile-time type checking via TypeScript
 * and runtime validation via Zod schemas.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

import type { AgentDefinition, RuleDefinition, SkillDefinition } from "./types";
import { agentDefinitionSchema, ruleDefinitionSchema, skillDefinitionSchema } from "./schemas";

/**
 * Define a skill with compile-time type checking and runtime validation.
 */
export function defineSkill(config: SkillDefinition): SkillDefinition {
  return skillDefinitionSchema.parse(config) as SkillDefinition;
}

/**
 * Define a rule with compile-time type checking and runtime validation.
 */
export function defineRule(config: RuleDefinition): RuleDefinition {
  return ruleDefinitionSchema.parse(config) as RuleDefinition;
}

/**
 * Define an agent with compile-time type checking and runtime validation.
 */
export function defineAgent(config: AgentDefinition): AgentDefinition {
  return agentDefinitionSchema.parse(config) as AgentDefinition;
}

/**
 * Load markdown content from a file adjacent to the definition module.
 *
 * @param dir - The directory containing the definition (use `import.meta.dir`)
 * @param filename - The markdown file to load (e.g., "content.md" or "prompt.md")
 */
export function loadMarkdown(dir: string, filename: string): string {
  const filePath = resolve(dir, filename);
  return readFileSync(filePath, "utf8") as string;
}
