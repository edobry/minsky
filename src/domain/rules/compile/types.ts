/**
 * Compile Target Types
 *
 * Shared types for the rules compile target architecture.
 */

import type { Rule } from "../types";
import type { RuleType } from "../rule-classifier";

export interface TargetOptions {
  outputPath?: string;
  ruleTypes?: RuleType[];
  tags?: string[];
  excludeTags?: string[];
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
}
