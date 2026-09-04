/**
 * Core type definitions for Minsky behavioral artifacts.
 *
 * All skills, rules, and agents are authored as TypeScript modules
 * using these interfaces and compiled to harness-specific formats.
 */

/**
 * A skill definition — procedural workflow invoked on-demand.
 * Compiles to: .claude/skills/<name>/SKILL.md (Agent Skills format)
 */
export interface SkillDefinition {
  /** Skill name. Lowercase letters, numbers, hyphens. Max 64 chars. Must match directory name. */
  name: string;
  /** What this skill does and when to use it. Max 1024 chars. */
  description: string;
  /** Categorization tags. */
  tags?: string[];
  /** Whether users can invoke via /name. Default: true. */
  userInvocable?: boolean;
  /** Prevent Claude from auto-invoking. Default: false. */
  disableModelInvocation?: boolean;
  /** Tools pre-approved when this skill is active. */
  allowedTools?: string[];
  /** The markdown body — the skill instructions. */
  content: string;
}

/**
 * A rule definition — declarative constraint (always-on or file-triggered).
 * Compiles to: .cursor/rules/<name>.mdc, AGENTS.md sections, CLAUDE.md
 */
/**
 * Which plane a rule belongs to (mt#4744's corpus audit).
 *
 * `product` is true and useful in a project that is not Minsky; `plant` is
 * about this repository's own code, hooks, tests, deploy or process; `mixed`
 * is a product core wrapped in repo incidents/paths; `template` ships its
 * structure while its content is per-project (`principal-context`).
 */
export type RulePlane = "product" | "plant" | "mixed" | "template";

/**
 * Adoption tier (ask#11286, 2026-09-04).
 *
 * `base` is on and NOT declinable — declining it breaks Minsky. `opinionated`
 * is on and declinable. `style` is off and opt-in.
 *
 * A tier is not an enforcement level. It says whether a rule ships and whether
 * the user may decline it, never how strongly it binds once present — so do not
 * read `base` as "stricter than" `opinionated` (RFC `3ce937f0`).
 */
export type RuleTier = "base" | "opinionated" | "style";

/** Lowest adoption rung at which a rule is proposed (mem#340's ladder). */
export type RuleRung = "T0" | "T1" | "T2" | "T3" | "T4";

export interface RuleDefinition {
  /** Rule display name. */
  name?: string;
  /** When this rule applies. Triggers rule loading. */
  description: string;
  /** If true, always included in context. */
  alwaysApply?: boolean;
  /** Categorization tags. */
  tags?: string[];
  /** File glob patterns that trigger this rule. */
  globs?: string | string[];
  /**
   * Plane classification (mt#4974 SC1). Optional: the 54 rules this repo
   * authored before the plane split carry none, and absence means unclassified
   * rather than `plant`.
   */
  plane?: RulePlane;
  /** Adoption tier (mt#4974 SC1). Optional; absence means untiered. */
  tier?: RuleTier;
  /** Lowest rung at which this rule is proposed (mt#4974 SC1). */
  minimumRung?: RuleRung;
  /**
   * Declares that reaching this rule ONLY through an explicit `rules_get <name>`
   * is deliberate (mt#3107).
   *
   * A rule carrying neither `alwaysApply: true` nor `globs` lands in neither
   * `CLAUDE.md` nor `.claude/rules`, and until this marker existed that state was
   * indistinguishable from a misconfiguration — the classifier bucketed the
   * intentional operational-reference rules with the broken ones. This makes the
   * intent declared rather than inferred from two absent keys.
   */
  onDemand?: boolean;
  /** The markdown body — the rule content. */
  content: string;
}

/** Model options for agent definitions. */
export type AgentModel = "sonnet" | "opus" | "haiku" | "inherit";

/** Permission modes for subagents. */
export type AgentPermissionMode = "default" | "acceptEdits" | "auto" | "dontAsk" | "plan";

/**
 * An agent definition — subagent configuration for dispatch.
 * Compiles to: .claude/agents/<name>.md (Claude Code format)
 */
export interface AgentDefinition {
  /** Agent identifier. Lowercase letters, numbers, hyphens. */
  name: string;
  /** What this agent does. Used for auto-delegation matching. */
  description: string;
  /** Model to use. Default: "inherit". */
  model?: AgentModel;
  /** Skills to preload into the agent's context at startup. */
  skills?: string[];
  /** Tools available to this agent. Omit for all tools. */
  tools?: string[];
  /** Tools explicitly denied to this agent. */
  disallowedTools?: string[];
  /** Permission mode for the agent. Default: "default". */
  permissionMode?: AgentPermissionMode;
  /** Maximum agentic turns before stopping. */
  maxTurns?: number;
  /** The system prompt — markdown body defining agent behavior. */
  prompt: string;
}
