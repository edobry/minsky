import type { Rule } from "./types";

/**
 * Enum for rule types based on Cursor's rule system
 */
export enum RuleType {
  ALWAYS_APPLY = "always",
  AUTO_ATTACHED = "auto_attached",
  AGENT_REQUESTED = "agent_requested",
  MANUAL = "manual"
}

/**
 * Classifies a rule into one of four types based on its frontmatter properties.
 * 
 * Priority order (matches Cursor's behavior):
 * 1. ALWAYS_APPLY - if alwaysApply is true
 * 2. AUTO_ATTACHED - if globs array exists and has patterns
 * 3. AGENT_REQUESTED - if description exists and is non-empty
 * 4. MANUAL - default if no special properties
 * 
 * @param rule - The rule to classify
 * @returns The RuleType classification
 */
export function classifyRuleType(rule: Rule): RuleType {
  // Priority 1: Always Apply
  if (rule.alwaysApply === true) {
    return RuleType.ALWAYS_APPLY;
  }
  
  // Priority 2: Auto Attached (glob matching)
  if (rule.globs && Array.isArray(rule.globs) && rule.globs.length > 0) {
    return RuleType.AUTO_ATTACHED;
  }
  
  // Priority 3: Agent Requested (has description)
  if (rule.description && rule.description.trim().length > 0) {
    return RuleType.AGENT_REQUESTED;
  }
  
  // Priority 4: Manual (default)
  return RuleType.MANUAL;
}

/**
 * Get a human-readable label for a rule type
 */
export function getRuleTypeLabel(type: RuleType): string {
  switch (type) {
    case RuleType.ALWAYS_APPLY:
      return "Always Apply";
    case RuleType.AUTO_ATTACHED:
      return "Auto Attached";
    case RuleType.AGENT_REQUESTED:
      return "Agent Requested";
    case RuleType.MANUAL:
      return "Manual";
    default:
      return "Unknown";
  }
}

/**
 * Get a description of how a rule type behaves
 */
export function getRuleTypeDescription(type: RuleType): string {
  switch (type) {
    case RuleType.ALWAYS_APPLY:
      return "Always included in model context";
    case RuleType.AUTO_ATTACHED:
      return "Included when files matching glob patterns are referenced";
    case RuleType.AGENT_REQUESTED:
      return "AI decides whether to include based on relevance";
    case RuleType.MANUAL:
      return "Only included when explicitly mentioned using @ruleName";
    default:
      return "Unknown rule type";
  }
}
