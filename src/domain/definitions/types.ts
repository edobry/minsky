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
