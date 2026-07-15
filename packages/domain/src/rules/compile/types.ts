/**
 * Compile Target Types
 *
 * Shared types for the rules compile target architecture.
 */

import type { Rule } from "../types";
import type { RuleType } from "../rule-classifier";
import type { MemoryLoadingMode } from "../../configuration/schemas/memory";
import type { SizeBudget, SizeBudgetStatus, RuleContribution } from "./size-budget";

export interface TargetOptions {
  outputPath?: string;
  ruleTypes?: RuleType[];
  tags?: string[];
  excludeTags?: string[];
  /**
   * Controls whether the memory-usage directive is emitted in CLAUDE.md.
   * - `"on_demand"` (default): emit the directive so the agent calls `memory_search`
   * - `"legacy"`: suppress the directive; relies on MEMORY.md preamble loader
   */
  memoryLoadingMode?: MemoryLoadingMode;
  /**
   * Per-call override of a target's default size budget (mt#2802). Either
   * field may be supplied independently; unset fields fall back to the
   * target's default. Only `claude.md` and `agents.md` currently enforce a
   * size budget — other targets ignore this option.
   */
  sizeBudget?: Partial<SizeBudget>;
}

export interface CompileResult {
  target: string;
  filesWritten: string[];
  rulesIncluded: string[];
  rulesSkipped: string[];
  /**
   * Compiled output size in characters (mt#2802). Present for targets that
   * enforce a size budget (`claude.md`, `agents.md`).
   */
  sizeChars?: number;
  /** The effective (default-or-override) budget this compile was evaluated against. */
  sizeBudget?: SizeBudget;
  /** Where `sizeChars` falls relative to `sizeBudget`. */
  sizeBudgetStatus?: SizeBudgetStatus;
  /** Rules ranked by compiled contribution size, descending (top N). */
  topContributors?: RuleContribution[];
  /**
   * Total chars of all included rules' emitted content; the remainder of
   * `sizeChars` is target scaffolding (banner, headers, section preamble).
   */
  ruleContentChars?: number;
}

export interface CompileTarget {
  id: string;
  displayName: string;
  defaultOutputPath(workspacePath: string): string;
  compile(rules: Rule[], options: TargetOptions, workspacePath: string): Promise<CompileResult>;
  /**
   * Return the list of all output file paths this target would produce for the given rules/options.
   * Used for staleness detection in --check mode.
   * For single-file targets, returns a single path. For multi-file targets (e.g. cursor-rules),
   * returns one path per output file.
   */
  listOutputFiles(rules: Rule[], options: TargetOptions, workspacePath: string): string[];
}
