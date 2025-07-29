#!/usr/bin/env bun

/**
 * Categorization Applier
 *
 * Applies the designed categorization system to existing rules by:
 * - Adding proper frontmatter with categories and tags
 * - Fixing malformed YAML frontmatter
 * - Updating metadata based on content analysis
 * - Validating categorization completeness
 */

import { readFile, writeFile, readdir } from "fs/promises";
import { join, extname, basename } from "path";
import matter from "gray-matter";
import { RuleAnalyzer, type RuleMetadata, type AnalysisResults } from "./rule-analyzer";

// Enhanced metadata interface for applying categorization
interface CategorizationUpdate {
  filePath: string;
  originalRule: RuleMetadata;
  updatedFrontmatter: Record<string, any>;
  needsUpdate: boolean;
  issues: string[];
}

class CategorizationApplier {
  private rulesDir: string;
  private analyzer: RuleAnalyzer;

  constructor(rulesDir: string = ".cursor/rules") {
    this.rulesDir = rulesDir;
    this.analyzer = new RuleAnalyzer(rulesDir);
  }

  /**
   * Apply categorization to all rules
   */
  async applyCategorization(): Promise<CategorizationUpdate[]> {
    console.log("🏷️  Starting categorization application...");

    // Get analysis results
    const results = await this.analyzer.analyzeRules();
    console.log(`📊 Analyzed ${results.total_rules} rules`);

    const updates: CategorizationUpdate[] = [];

    for (const rule of results.rules) {
      try {
        const update = await this.processRule(rule);
        updates.push(update);

        if (update.needsUpdate) {
          console.log(`✏️  Updated: ${rule.name}`);
        } else {
          console.log(`✅ Already categorized: ${rule.name}`);
        }
      } catch (error) {
        console.error(`❌ Failed to process ${rule.name}:`, error);
        updates.push({
          filePath: rule.filePath,
          originalRule: rule,
          updatedFrontmatter: {},
          needsUpdate: false,
          issues: [`Processing error: ${error}`],
        });
      }
    }

    // Handle files that failed initial analysis (malformed YAML)
    await this.fixMalformedFiles();

    console.log(
      `🎯 Categorization complete. ${updates.filter((u) => u.needsUpdate).length} rules updated.`
    );
    return updates;
  }

  /**
   * Process a single rule for categorization
   */
  private async processRule(rule: RuleMetadata): Promise<CategorizationUpdate> {
    const content = await readFile(rule.filePath, "utf-8");
    const parsed = matter(content);

    const issues: string[] = [];
    let needsUpdate = false;

    // Generate enhanced frontmatter
    const updatedFrontmatter = {
      ...parsed.data,
      name: rule.name,
      description: rule.description,
      categories: this.refineCategorization(rule.categories, rule),
      tags: this.refineTags(rule.tags, rule),
      lifecycle: parsed.data.lifecycle || "active",
      verbosity_score: rule.verbosity_score,
      word_count: rule.word_count,
      content_themes: rule.content_themes,
      cli_commands: rule.cli_commands.slice(0, 10), // Limit for readability
      last_analyzed: new Date().toISOString(),
    };

    // Check if updates are needed
    const originalCategories = parsed.data.categories || [];
    const originalTags = parsed.data.tags || [];

    if (JSON.stringify(originalCategories) !== JSON.stringify(updatedFrontmatter.categories)) {
      needsUpdate = true;
      issues.push("Categories updated");
    }

    if (JSON.stringify(originalTags) !== JSON.stringify(updatedFrontmatter.tags)) {
      needsUpdate = true;
      issues.push("Tags updated");
    }

    if (!parsed.data.name || parsed.data.name !== rule.name) {
      needsUpdate = true;
      issues.push("Name standardized");
    }

    if (!parsed.data.description || parsed.data.description !== rule.description) {
      needsUpdate = true;
      issues.push("Description added/updated");
    }

    // Add quality metrics if missing
    if (!parsed.data.verbosity_score) {
      needsUpdate = true;
      issues.push("Verbosity score added");
    }

    return {
      filePath: rule.filePath,
      originalRule: rule,
      updatedFrontmatter,
      needsUpdate,
      issues,
    };
  }

  /**
   * Refine categorization based on analysis and manual review
   */
  private refineCategorization(suggestedCategories: string[], rule: RuleMetadata): string[] {
    const refined = new Set(suggestedCategories);
    const filename = basename(rule.filePath, extname(rule.filePath));
    const content = rule.frontmatter;

    // Manual refinements based on specific rules
    const manualMappings = {
      "minsky-workflow-orchestrator": ["workflow", "meta"],
      "task-implementation-workflow": ["workflow"],
      "session-first-workflow": ["workflow"],
      "pr-preparation-workflow": ["workflow"],
      "git-usage-policy": ["tools", "workflow"],
      "test-driven-bugfix": ["testing", "quality"],
      "testing-boundaries": ["testing"],
      "framework-specific-tests": ["testing", "tools"],
      "bun-test-patterns": ["testing", "tools"],
      "rule-creation-guidelines": ["meta", "documentation"],
      "derived-cursor-rules": ["meta"],
      "domain-oriented-modules": ["organization"],
      "command-organization": ["organization"],
      "architectural-bypass-prevention": ["organization", "quality"],
      "robust-error-handling": ["quality"],
      "dont-ignore-errors": ["quality"],
      "variable-naming-protocol": ["quality"],
      "pr-description-guidelines": ["documentation", "workflow"],
      changelog: ["documentation"],
      "minsky-cli-usage": ["tools"],
      "minsky-session-management": ["workflow", "tools"],
      "task-status-protocol": ["workflow"],
      "cli-testing": ["testing", "tools"],
      "automation-approaches": ["project-types", "tools"],
      "codemods-development-standards": ["project-types", "quality"],
      "user-preferences": ["meta"],
    };

    if (manualMappings[filename]) {
      return manualMappings[filename];
    }

    // Apply refinement logic
    const categories = Array.from(refined);

    // Ensure workflow rules have workflow category
    if (filename.includes("workflow") && !categories.includes("workflow")) {
      categories.unshift("workflow");
    }

    // Ensure testing rules have testing category
    if (filename.includes("test") && !categories.includes("testing")) {
      categories.unshift("testing");
    }

    // Ensure tool-specific rules have tools category
    if (
      ["git", "bun", "cli", "mcp"].some((tool) => filename.includes(tool)) &&
      !categories.includes("tools")
    ) {
      categories.push("tools");
    }

    // Limit to 3 categories
    return categories.slice(0, 3);
  }

  /**
   * Refine tags based on analysis and content
   */
  private refineTags(suggestedTags: string[], rule: RuleMetadata): string[] {
    const refined = new Set(suggestedTags);
    const filename = basename(rule.filePath, extname(rule.filePath));

    // Add core tags for fundamental rules
    const coreRules = [
      "minsky-workflow-orchestrator",
      "task-implementation-workflow",
      "session-first-workflow",
      "minsky-cli-usage",
      "task-status-protocol",
    ];

    if (coreRules.includes(filename)) {
      refined.add("core");
      refined.add("required");
    }

    // Add workflow stage tags
    if (filename.includes("workflow")) {
      refined.add("process");
    }

    if (filename.includes("test")) {
      refined.add("quality");
    }

    if (filename.includes("rule") || filename.includes("template")) {
      refined.add("meta");
    }

    // Add technology tags
    if (rule.cli_commands.some((cmd) => cmd.includes("minsky"))) {
      refined.add("minsky");
    }

    if (rule.cli_commands.some((cmd) => cmd.includes("git"))) {
      refined.add("git");
    }

    if (rule.cli_commands.some((cmd) => cmd.includes("bun"))) {
      refined.add("bun");
    }

    // Ensure reasonable tag count (3-8)
    const tags = Array.from(refined);
    return tags.slice(0, 8);
  }

  /**
   * Apply updates to files
   */
  async applyUpdates(updates: CategorizationUpdate[]): Promise<void> {
    console.log("💾 Applying categorization updates...");

    for (const update of updates) {
      if (!update.needsUpdate) continue;

      try {
        const content = await readFile(update.filePath, "utf-8");
        const parsed = matter(content);

        // Create updated content with new frontmatter
        const updatedContent = matter.stringify(parsed.content, update.updatedFrontmatter);

        await writeFile(update.filePath, updatedContent);
        console.log(`✅ Updated ${update.originalRule.name}: ${update.issues.join(", ")}`);
      } catch (error) {
        console.error(`❌ Failed to update ${update.filePath}:`, error);
      }
    }
  }

  /**
   * Fix files with malformed YAML frontmatter
   */
  private async fixMalformedFiles(): Promise<void> {
    const problematicFiles = [
      "designing-tests.mdc",
      "framework-specific-tests.mdc",
      "no-dynamic-imports.mdc",
      "rule-creation-guidelines.mdc",
      "task-status-protocol.mdc",
    ];

    console.log("🔧 Fixing malformed YAML frontmatter...");

    for (const filename of problematicFiles) {
      const filePath = join(this.rulesDir, filename);

      try {
        const content = await readFile(filePath, "utf-8");
        const fixed = await this.fixYamlFrontmatter(content, filename);

        if (fixed !== content) {
          await writeFile(filePath, fixed);
          console.log(`✅ Fixed YAML in ${filename}`);
        }
      } catch (error) {
        console.error(`❌ Failed to fix ${filename}:`, error);
      }
    }
  }

  /**
   * Fix common YAML frontmatter issues
   */
  private async fixYamlFrontmatter(content: string, filename: string): Promise<string> {
    let fixed = content;

    // Fix glob patterns that need quoting
    fixed = fixed.replace(/globs: \*\*\/\*\.([a-zA-Z]+)/g, 'globs: "**/*.$1"');
    fixed = fixed.replace(
      /globs: \*\*\/\*\.([a-zA-Z]+)', \*\*\/\*\.([a-zA-Z]+)/g,
      'globs: ["**/*.$1", "**/*.$2"]'
    );
    fixed = fixed.replace(
      /globs: \*\*\/\*\.([a-zA-Z]+), \*\*\/\*\.([a-zA-Z]+), \*\*\/\*\.([a-zA-Z]+), \*\*\/\*\.([a-zA-Z]+)/g,
      'globs: ["**/*.$1", "**/*.$2", "**/*.$3", "**/*.$4"]'
    );

    // Fix task-status-protocol.mdc specific issue
    if (filename === "task-status-protocol.mdc") {
      // Find where frontmatter ends incorrectly
      const frontmatterEnd = fixed.indexOf("# Task Status Protocol");
      if (frontmatterEnd > 0) {
        const beforeProtocol = fixed.substring(0, frontmatterEnd);
        const afterProtocol = fixed.substring(frontmatterEnd);

        // Add proper frontmatter closing
        if (!beforeProtocol.trim().endsWith("---")) {
          fixed = `${beforeProtocol.trim()}\n---\n\n${afterProtocol}`;
        }
      }
    }

    return fixed;
  }

  /**
   * Generate categorization report
   */
  async generateReport(updates: CategorizationUpdate[]): Promise<void> {
    const reportPath = "scripts/rule-analysis/categorization-report.md";

    const totalRules = updates.length;
    const updatedRules = updates.filter((u) => u.needsUpdate).length;
    const categorizedRules = updates.filter(
      (u) => u.updatedFrontmatter.categories?.length > 0
    ).length;

    const categoryStats: Record<string, number> = {};
    const tagStats: Record<string, number> = {};

    updates.forEach((update) => {
      update.updatedFrontmatter.categories?.forEach((cat: string) => {
        categoryStats[cat] = (categoryStats[cat] || 0) + 1;
      });

      update.updatedFrontmatter.tags?.forEach((tag: string) => {
        tagStats[tag] = (tagStats[tag] || 0) + 1;
      });
    });

    const report = `# Rule Categorization Report

## Summary

- **Total Rules**: ${totalRules}
- **Updated Rules**: ${updatedRules}
- **Categorized Rules**: ${categorizedRules}
- **Coverage**: ${Math.round((categorizedRules / totalRules) * 100)}%

## Category Distribution

${Object.entries(categoryStats)
  .sort(([, a], [, b]) => b - a)
  .map(([cat, count]) => `- **${cat}**: ${count} rules`)
  .join("\n")}

## Tag Distribution

${Object.entries(tagStats)
  .sort(([, a], [, b]) => b - a)
  .slice(0, 20) // Top 20 tags
  .map(([tag, count]) => `- **${tag}**: ${count} rules`)
  .join("\n")}

## Rules by Category

${Object.entries(categoryStats)
  .map(([category, count]) => {
    const rulesInCategory = updates.filter((u) =>
      u.updatedFrontmatter.categories?.includes(category)
    );
    return `### ${category} (${count} rules)

${rulesInCategory.map((u) => `- ${u.originalRule.name}`).join("\n")}`;
  })
  .join("\n\n")}

## Issues Found

${updates
  .filter((u) => u.issues.length > 0)
  .map(
    (u) =>
      `### ${u.originalRule.name}
${u.issues.map((issue) => `- ${issue}`).join("\n")}`
  )
  .join("\n\n")}

Generated on: ${new Date().toISOString()}
`;

    await Bun.write(reportPath, report);
    console.log(`📊 Categorization report saved to: ${reportPath}`);
  }
}

// Main execution
async function main() {
  const applier = new CategorizationApplier();

  try {
    const updates = await applier.applyCategorization();

    // Generate report before applying changes
    await applier.generateReport(updates);

    // Apply the updates to files
    await applier.applyUpdates(updates);

    console.log("\n🎉 Categorization application complete!");
    console.log("📋 Check categorization-report.md for detailed results");
  } catch (error) {
    console.error("❌ Categorization application failed:", error);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}

export { CategorizationApplier };
export type { CategorizationUpdate };
