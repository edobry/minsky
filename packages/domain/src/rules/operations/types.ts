/**
 * Rules Command Operation Types
 *
 * Shared interfaces and type definitions used by the rules command
 * operation sub-modules.
 */

import type { RuleFormat } from "../../rules";
import type { MemoryLoadingMode } from "../../configuration/schemas/memory";
import type { SizeBudget, SizeBudgetStatus, RuleContribution } from "../compile/size-budget";

// ─── Rules Selection Config ──────────────────────────────────────────────────

export interface RulesSelectionConfig {
  presets: string[];
  enabled: string[];
  disabled: string[];
}

// ─── Migration ───────────────────────────────────────────────────────────────

/** Minimal fs interface required by migrateRules — injectable for testing. */
export interface MigrateFsDeps {
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<string | undefined>;
  access(path: string): Promise<void>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer | string): Promise<void>;
}

export interface MigrateRulesOptions {
  workspacePath: string;
  dryRun: boolean;
  force: boolean;
  /** Optional fs override for testing — uses real fs/promises when omitted. */
  fsDeps?: MigrateFsDeps;
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

// ─── Index Embeddings ────────────────────────────────────────────────────────

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

// ─── Enhanced Search ─────────────────────────────────────────────────────────

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

// ─── Config / Presets ────────────────────────────────────────────────────────

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

// ─── List Rules ──────────────────────────────────────────────────────────────

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

// ─── Compile Rules ───────────────────────────────────────────────────────────

export interface CompileRulesOptions {
  workspacePath: string;
  target?: string;
  output?: string;
  dryRun?: boolean;
  check?: boolean;
  memoryLoadingMode?: MemoryLoadingMode;
  /** Per-target size-budget override (mt#2802). See `TargetOptions.sizeBudget`. */
  sizeBudget?: Partial<SizeBudget>;
}

export interface CompileRulesResult {
  success: boolean;
  check?: boolean;
  stale?: boolean;
  staleFile?: string;
  dryRun?: boolean;
  content?: string;
  filesWritten?: string[];
  rulesIncluded?: string[];
  rulesSkipped?: string[];
  /** Compiled output size in characters (mt#2802). */
  sizeChars?: number;
  /** The effective budget this compile was evaluated against. */
  sizeBudget?: SizeBudget;
  /** Where `sizeChars` falls relative to `sizeBudget`. */
  sizeBudgetStatus?: SizeBudgetStatus;
  /** Rules ranked by compiled contribution size, descending (top N). */
  topContributors?: RuleContribution[];
  /** Total chars of included rules' emitted content (remainder = target scaffolding). */
  ruleContentChars?: number;
  /**
   * Populated when a bare (no explicit `--target`) invocation probed and
   * compiled MULTIPLE applicable targets (mt#2803). Each entry mirrors this
   * result shape, scoped to one target. When present, the top-level fields
   * above carry the cross-target aggregate (`filesWritten` etc. concatenated,
   * `success`/`stale` reduced via AND/OR) — consumers that want per-target
   * detail (e.g. size-budget status, which is not aggregable) should iterate
   * `targets` instead. Absent for explicit `--target` invocations and for
   * bare invocations that probe to exactly one applicable target.
   */
  targets?: CompileRulesTargetResult[];
}

/**
 * Per-target outcome inside a multi-target `CompileRulesResult.targets`
 * array (mt#2803). Mirrors `CompileRulesResult` (minus `targets` itself,
 * which does not nest) plus the `target` id it was compiled for.
 */
export type CompileRulesTargetResult = Omit<CompileRulesResult, "targets"> & {
  target: string;
};

// ─── Get Rule ────────────────────────────────────────────────────────────────

export interface GetRuleOptions {
  workspacePath: string;
  id: string;
  format?: RuleFormat;
  debug?: boolean;
}

export interface GetRuleResult {
  success: boolean;
  rule: import("../types").Rule;
}

// ─── Generate Rules ──────────────────────────────────────────────────────────

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

// ─── Create Rule ─────────────────────────────────────────────────────────────

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
  rule: import("../types").Rule;
}

// ─── Update Rule ─────────────────────────────────────────────────────────────

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
  rule: import("../types").Rule;
}
