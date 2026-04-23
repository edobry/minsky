/**
 * Compile Target Types
 *
 * Shared types for the rules compile target architecture.
 */

import type { Rule } from "../types";
import type { RuleType } from "../rule-classifier";
import type { MemoryLoadingMode } from "../../configuration/schemas/memory";

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
}

export interface CompileResult {
  target: string;
  filesWritten: string[];
  rulesIncluded: string[];
  rulesSkipped: string[];
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
