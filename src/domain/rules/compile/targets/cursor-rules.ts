/**
 * Cursor Rules Compile Target
 *
 * Compiles rules into individual .mdc files written to .cursor/rules/.
 * Unlike monolithic targets (AGENTS.md, CLAUDE.md), this is a multi-file target
 * that preserves each rule as a separate file with its original frontmatter.
 */

import { join } from "path";
import * as fs from "fs/promises";
import * as jsYaml from "js-yaml";
import type { Rule } from "../../types";
import type { CompileTarget, CompileResult, TargetOptions } from "../types";

/**
 * Serialize a Rule back to .mdc format (YAML frontmatter + markdown content)
 */
function serializeRuleToMdc(rule: Rule): string {
  const frontmatter: Record<string, unknown> = {};

  if (rule.name) frontmatter.name = rule.name;
  if (rule.description) frontmatter.description = rule.description;
  if (rule.globs) frontmatter.globs = rule.globs;
  if (rule.alwaysApply !== undefined) frontmatter.alwaysApply = rule.alwaysApply;
  if (rule.tags) frontmatter.tags = rule.tags;

  const yamlStr = jsYaml.dump(frontmatter, {
    lineWidth: -1,
    noCompatMode: true,
    quotingType: '"',
    forceQuotes: false,
  });

  return `---\n${yamlStr}---\n${rule.content}`;
}

export interface CursorRulesFileList {
  files: Array<{ path: string; content: string }>;
  rulesIncluded: string[];
  rulesSkipped: string[];
}

/**
 * Build the list of files that would be written for cursor-rules target.
 * Used for both actual compilation and dry-run support.
 */
export function buildCursorRulesContent(rules: Rule[], outputDir: string): CursorRulesFileList {
  const files: Array<{ path: string; content: string }> = [];
  const rulesIncluded: string[] = [];
  const rulesSkipped: string[] = [];

  for (const rule of rules) {
    const filePath = join(outputDir, `${rule.id}.mdc`);
    const content = serializeRuleToMdc(rule);
    files.push({ path: filePath, content });
    rulesIncluded.push(rule.id);
  }

  return { files, rulesIncluded, rulesSkipped };
}

/**
 * Cursor Rules compile target implementation.
 * Writes each rule as a separate .mdc file to .cursor/rules/.
 */
export const cursorRulesTarget: CompileTarget = {
  id: "cursor-rules",
  displayName: "Cursor Rules (.cursor/rules/)",

  defaultOutputPath(workspacePath: string): string {
    return join(workspacePath, ".cursor", "rules");
  },

  listOutputFiles(rules: Rule[], options: TargetOptions, workspacePath: string): string[] {
    const outputDir = options.outputPath || this.defaultOutputPath(workspacePath);
    const { files } = buildCursorRulesContent(rules, outputDir);
    return files.map((f) => f.path);
  },

  async compile(
    rules: Rule[],
    options: TargetOptions,
    workspacePath: string
  ): Promise<CompileResult> {
    const outputDir = options.outputPath || this.defaultOutputPath(workspacePath);

    // Ensure the output directory exists
    await fs.mkdir(outputDir, { recursive: true });

    const { files, rulesIncluded, rulesSkipped } = buildCursorRulesContent(rules, outputDir);

    const filesWritten: string[] = [];
    for (const { path: filePath, content } of files) {
      await fs.writeFile(filePath, content, "utf-8");
      filesWritten.push(filePath);
    }

    return {
      target: this.id,
      filesWritten,
      rulesIncluded,
      rulesSkipped,
    };
  },
};

// Export helpers for testing
export { serializeRuleToMdc };
