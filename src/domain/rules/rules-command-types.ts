/**
 * Rules Command Types
 *
 * Shared types and interfaces for rules command operations.
 */
import type { RuleFormat } from "../rules";
import type { Rule } from "./types";

// ─── Selection / Presets ─────────────────────────────────────────────────────

export interface RulesSelectionConfig {
  presets: string[];
  enabled: string[];
  disabled: string[];
}

export interface RulesConfigResult {
  success: boolean;
  presets: string[];
  enabled: string[];
  disabled: string[];
  activeRuleCount: number;
  totalRuleCount: number;
}

export interface RulesPresetsResult {
  success: boolean;
  presets: Array<{ name: string; ruleCount: number; rules: string[] }>;
}

// ─── Migration ───────────────────────────────────────────────────────────────

export interface MigrateRulesOptions {
  workspacePath: string;
  dryRun: boolean;
  force: boolean;
}

export interface MigrateRulesResult {
  success: boolean;
  error?: string;
  dryRun?: boolean;
  migrated?: string[];
  skipped?: string[];
  sourceDir?: string;
  destDir?: string;
  nextSteps?: string[];
}

// ─── Embeddings / Search ─────────────────────────────────────────────────────

export interface IndexEmbeddingsOptions {
  workspacePath: string;
  limit?: number;
  force?: boolean;
  json?: boolean;
  debug?: boolean;
}

export interface IndexEmbeddingsResult {
  success: boolean;
  indexed?: number;
  skipped?: number;
  total?: number;
  ms?: number;
  error?: string;
}

export interface EnhancedRuleSearchResult {
  id: string;
  score: number;
  name: string;
  description: string;
  format: string;
}

export interface SearchRulesEnhancedOptions {
  workspacePath: string;
  query?: string;
  limit?: number;
  threshold?: number;
}

// ─── List / Compile ───────────────────────────────────────────────────────────

export interface ListRulesOptions {
  workspacePath: string;
  format?: RuleFormat;
  tag?: string;
  since?: string;
  until?: string;
  debug?: boolean;
}

export interface ListRulesResult {
  success: boolean;
  rules: Array<Record<string, unknown>>;
}

export interface CompileRulesOptions {
  workspacePath: string;
  target?: string;
  output?: string;
  dryRun?: boolean;
  check?: boolean;
}

export interface CompileRulesResult {
  success: boolean;
  check?: boolean;
  stale?: boolean;
  dryRun?: boolean;
  content?: string;
  filesWritten?: string[];
  rulesIncluded?: string[];
  rulesSkipped?: string[];
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export interface GetRuleOptions {
  workspacePath: string;
  id: string;
  format?: RuleFormat;
  debug?: boolean;
}

export interface GetRuleResult {
  success: boolean;
  rule: Rule;
}

export interface CreateRuleOptions {
  workspacePath: string;
  id: string;
  content: string;
  description?: string;
  name?: string;
  globs?: string;
  tags?: string;
  format?: RuleFormat;
  overwrite?: boolean;
}

export interface CreateRuleResult {
  success: boolean;
  rule: Rule;
}

export interface UpdateRuleOptions {
  workspacePath: string;
  id: string;
  content?: string;
  description?: string;
  name?: string;
  globs?: string;
  tags?: string;
  format?: RuleFormat;
  debug?: boolean;
}

export interface UpdateRuleResult {
  success: boolean;
  rule: Rule;
}

// ─── Generate ─────────────────────────────────────────────────────────────────

export interface GenerateRulesOptions {
  workspacePath: string;
  interface?: "cli" | "mcp" | "hybrid";
  rules?: string;
  outputDir?: string;
  dryRun?: boolean;
  overwrite?: boolean;
  format?: RuleFormat;
  preferMcp?: boolean;
  mcpTransport?: "stdio" | "http";
}

export interface GenerateRulesResult {
  success: boolean;
  rules: unknown[];
  errors: unknown[];
  generated: number;
}
