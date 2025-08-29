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
 * Result of rule classification, including type and any validation warnings
 */
export interface RuleClassificationResult {
  type: RuleType;
  warnings?: string[];
}

/**
 * Classifies a rule into one of four types based on its frontmatter properties.
 * Issues warnings for rules with multiple classification properties.
 * 
 * Priority order:
 * 1. ALWAYS_APPLY - if alwaysApply is true
 * 2. AUTO_ATTACHED - if globs array exists and has patterns
 * 3. AGENT_REQUESTED - if description exists and is non-empty
 * 4. MANUAL - default if no special properties
 * 
 * @param rule - The rule to classify
 * @returns The RuleType classification
 */
export function classifyRuleType(rule: Rule): RuleType {
  return classifyRuleTypeWithWarnings(rule).type;
}

/**
 * Classifies a rule and returns both the type and any validation warnings.
 * Detects rules with multiple classification properties that should be cleaned up.
 * 
 * @param rule - The rule to classify
 * @returns Classification result with type and warnings
 */
export function classifyRuleTypeWithWarnings(rule: Rule): RuleClassificationResult {
  const warnings: string[] = [];
  
  // Check for multiple classification properties
  const hasAlwaysApply = rule.alwaysApply === true;
  const hasGlobs = rule.globs && Array.isArray(rule.globs) && rule.globs.length > 0;
  const hasDescription = rule.description && rule.description.trim().length > 0;
  
  const classificationProps = [
    hasAlwaysApply && "alwaysApply",
    hasGlobs && "globs", 
    hasDescription && "description"
  ].filter(Boolean);
  
  if (classificationProps.length > 1) {
    warnings.push(
      `Rule '${rule.id}' has multiple classification properties: [${classificationProps.join(", ")}]. ` +
      `Consider using only one classification property per rule for clarity. ` +
      `Current priority: ${classificationProps[0]} (${classificationProps.slice(1).join(", ")} ignored)`
    );
  }
  
  // Priority classification (unchanged logic)
  // Priority 1: Always Apply
  if (hasAlwaysApply) {
    return { type: RuleType.ALWAYS_APPLY, warnings: warnings.length > 0 ? warnings : undefined };
  }
  
  // Priority 2: Auto Attached (glob matching)
  if (hasGlobs) {
    return { type: RuleType.AUTO_ATTACHED, warnings: warnings.length > 0 ? warnings : undefined };
  }
  
  // Priority 3: Agent Requested (has description)
  if (hasDescription) {
    return { type: RuleType.AGENT_REQUESTED, warnings: warnings.length > 0 ? warnings : undefined };
  }
  
  // Priority 4: Manual (default)
  return { type: RuleType.MANUAL, warnings: warnings.length > 0 ? warnings : undefined };
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
