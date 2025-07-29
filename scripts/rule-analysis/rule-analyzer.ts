#!/usr/bin/env bun

/**
 * Rule Analysis Tool
 *
 * Analyzes all existing rules in the .cursor/rules directory to:
 * - Extract content patterns and themes
 * - Identify CLI command references
 * - Calculate content similarity metrics
 * - Suggest categorization based on content analysis
 */

import { readdir, readFile, stat } from "fs/promises";
import { join, extname, basename } from "path";
import matter from "gray-matter";
import { createHash } from "crypto";

// Rule metadata interface
interface RuleMetadata {
  name: string;
  filePath: string;
  description: string;
  categories: string[];
  tags: string[];
  lifecycle: "active" | "deprecated" | "experimental";
  redundancy_risk: "low" | "medium" | "high";
  verbosity_score: number; // 1-5 scale (1=concise, 5=verbose)
  related_rules: string[];
  cli_commands: string[];
  content_hash: string;
  word_count: number;
  line_count: number;
  last_updated: Date | null;
  content_themes: string[];
  frontmatter: Record<string, any>;
}

// Analysis results interface
interface AnalysisResults {
  total_rules: number;
  rules: RuleMetadata[];
  content_themes: Record<string, number>;
  cli_commands: Record<string, number>;
  suggested_categories: Record<string, string[]>;
  redundancy_matrix: Array<{ rule1: string; rule2: string; similarity: number }>;
  verbosity_distribution: Record<number, number>;
}

class RuleAnalyzer {
  private rulesDir: string;

  constructor(rulesDir: string = ".cursor/rules") {
    this.rulesDir = rulesDir;
  }

  /**
   * Main analysis function
   */
  async analyzeRules(): Promise<AnalysisResults> {
    console.log(`🔍 Starting rule analysis in ${this.rulesDir}...`);

    const ruleFiles = await this.getRuleFiles();
    console.log(`📝 Found ${ruleFiles.length} rule files`);

    const rules: RuleMetadata[] = [];

    for (const filePath of ruleFiles) {
      try {
        const metadata = await this.analyzeRule(filePath);
        rules.push(metadata);
        console.log(`✅ Analyzed: ${metadata.name}`);
      } catch (error) {
        console.error(`❌ Failed to analyze ${filePath}:`, error);
      }
    }

    // Generate analysis results
    const results: AnalysisResults = {
      total_rules: rules.length,
      rules,
      content_themes: this.extractContentThemes(rules),
      cli_commands: this.extractCliCommands(rules),
      suggested_categories: this.suggestCategories(rules),
      redundancy_matrix: this.calculateRedundancy(rules),
      verbosity_distribution: this.analyzeVerbosity(rules),
    };

    console.log(`🎯 Analysis complete: ${results.total_rules} rules processed`);
    return results;
  }

  /**
   * Get all rule files from the rules directory
   */
  private async getRuleFiles(): Promise<string[]> {
    const files = await readdir(this.rulesDir);
    const ruleFiles: string[] = [];

    for (const file of files) {
      if (extname(file) === ".mdc" || extname(file) === ".md") {
        const filePath = join(this.rulesDir, file);
        const stats = await stat(filePath);
        if (stats.isFile()) {
          ruleFiles.push(filePath);
        }
      }
    }

    return ruleFiles.sort();
  }

  /**
   * Analyze a single rule file
   */
  private async analyzeRule(filePath: string): Promise<RuleMetadata> {
    const content = await readFile(filePath, "utf-8");
    const parsed = matter(content);
    const filename = basename(filePath, extname(filePath));

    // Extract basic metrics
    const lines = content.split("\n");
    const words = content.split(/\s+/).filter((w) => w.length > 0);
    const contentHash = createHash("md5").update(parsed.content).digest("hex");

    // Extract CLI commands
    const cliCommands = this.extractCliCommandsFromContent(parsed.content);

    // Extract content themes
    const contentThemes = this.extractThemesFromContent(parsed.content);

    // Calculate verbosity score
    const verbosityScore = this.calculateVerbosityScore(words.length, lines.length);

    // Suggest initial categorization
    const suggestedCategories = this.suggestCategoriesForRule(parsed.content, filename);
    const suggestedTags = this.suggestTagsForRule(parsed.content, filename, cliCommands);

    const metadata: RuleMetadata = {
      name: parsed.data.name || this.formatRuleName(filename),
      filePath,
      description: parsed.data.description || this.extractDescription(parsed.content),
      categories: parsed.data.categories || suggestedCategories,
      tags: parsed.data.tags || suggestedTags,
      lifecycle: parsed.data.lifecycle || "active",
      redundancy_risk: "low", // Will be calculated in redundancy analysis
      verbosity_score: verbosityScore,
      related_rules: parsed.data.related_rules || [],
      cli_commands: cliCommands,
      content_hash: contentHash,
      word_count: words.length,
      line_count: lines.length,
      last_updated: parsed.data.last_updated ? new Date(parsed.data.last_updated) : null,
      content_themes: contentThemes,
      frontmatter: parsed.data,
    };

    return metadata;
  }

  /**
   * Extract CLI commands from rule content
   */
  private extractCliCommandsFromContent(content: string): string[] {
    const commands = new Set<string>();

    // Pattern for minsky commands
    const minskyCmdPattern = /minsky\s+[\w\s-]+/g;
    const minskyCmds = content.match(minskyCmdPattern) || [];
    minskyCmds.forEach((cmd) => commands.add(cmd.trim()));

    // Pattern for common CLI tools
    const cliToolPatterns = [
      /\b(git|npm|yarn|bun|docker|kubectl)\s+[\w\s-]+/g,
      /\$\s*[\w-]+/g, // Shell commands
      /`[^`]*`/g, // Code blocks that might contain commands
    ];

    cliToolPatterns.forEach((pattern) => {
      const matches = content.match(pattern) || [];
      matches.forEach((match) => {
        const cleanMatch = match.replace(/[`$]/g, "").trim();
        if (cleanMatch.length > 2) {
          commands.add(cleanMatch);
        }
      });
    });

    return Array.from(commands).slice(0, 20); // Limit to prevent noise
  }

  /**
   * Extract content themes from rule text
   */
  private extractThemesFromContent(content: string): string[] {
    const themes = new Set<string>();

    // Key theme patterns
    const themePatterns = {
      "task-management": /\b(task|tasks|status|implementation|workflow)\b/gi,
      "session-management": /\b(session|sessions|workspace|directory)\b/gi,
      testing: /\b(test|tests|testing|spec|verify|validation)\b/gi,
      "git-workflow": /\b(git|branch|commit|pull|request|merge|pr)\b/gi,
      "cli-commands": /\b(command|commands|cli|minsky)\b/gi,
      "code-organization": /\b(module|modules|organization|structure|architecture)\b/gi,
      "error-handling": /\b(error|errors|handling|exception|robust)\b/gi,
      documentation: /\b(document|documentation|docs|readme|guide)\b/gi,
      "rules-management": /\b(rule|rules|template|templates|meta)\b/gi,
      automation: /\b(automation|automated|script|scripts|tool)\b/gi,
    };

    for (const [theme, pattern] of Object.entries(themePatterns)) {
      const matches = content.match(pattern);
      if (matches && matches.length >= 3) {
        // Threshold for theme relevance
        themes.add(theme);
      }
    }

    return Array.from(themes);
  }

  /**
   * Calculate verbosity score (1-5 scale)
   */
  private calculateVerbosityScore(wordCount: number, lineCount: number): number {
    // Scoring based on content length
    if (wordCount < 200) return 1; // Very concise
    if (wordCount < 500) return 2; // Concise
    if (wordCount < 1000) return 3; // Moderate
    if (wordCount < 2000) return 4; // Verbose
    return 5; // Very verbose
  }

  /**
   * Suggest categories for a rule
   */
  private suggestCategoriesForRule(content: string, filename: string): string[] {
    const categories = new Set<string>();

    // Category mapping based on content and filename
    const categoryPatterns = {
      workflow: /\b(workflow|process|step|phase|lifecycle)\b/gi,
      tools: /\b(tool|tools|cli|command|git|docker|bun|npm)\b/gi,
      testing: /\b(test|testing|spec|verify|mock|fixture)\b/gi,
      documentation: /\b(document|docs|readme|guide|index|description)\b/gi,
      meta: /\b(rule|rules|template|cursor|creation|guidelines)\b/gi,
      session: /\b(session|workspace|directory|isolation)\b/gi,
      task: /\b(task|tasks|status|implementation|management)\b/gi,
      git: /\b(git|branch|commit|pull|request|merge|pr)\b/gi,
      "code-quality": /\b(error|handling|robust|quality|standards|best)\b/gi,
      organization: /\b(module|organization|structure|architecture|domain)\b/gi,
    };

    // Check filename patterns
    const filenamePatterns = {
      workflow: /-workflow|-process/,
      testing: /test|spec/,
      session: /session/,
      task: /task/,
      git: /git|pr/,
      rules: /rule|template/,
      cli: /cli|command/,
    };

    // Analyze content
    for (const [category, pattern] of Object.entries(categoryPatterns)) {
      if (content.match(pattern)) {
        categories.add(category);
      }
    }

    // Analyze filename
    for (const [category, pattern] of Object.entries(filenamePatterns)) {
      if (filename.match(pattern)) {
        categories.add(category);
      }
    }

    return Array.from(categories).slice(0, 3); // Limit to 3 main categories
  }

  /**
   * Suggest tags for a rule
   */
  private suggestTagsForRule(content: string, filename: string, cliCommands: string[]): string[] {
    const tags = new Set<string>();

    // Add CLI command tags
    cliCommands.forEach((cmd) => {
      const mainCmd = cmd.split(" ")[0];
      if (["minsky", "git", "bun", "npm", "docker"].includes(mainCmd)) {
        tags.add(mainCmd);
      }
    });

    // Content-based tags
    const tagPatterns = {
      ai: /\b(ai|artificial|intelligence|agent|llm)\b/gi,
      mcp: /\b(mcp|protocol|model|context)\b/gi,
      backend: /\b(backend|server|api|database)\b/gi,
      frontend: /\b(frontend|client|ui|interface)\b/gi,
      required: /\b(required|mandatory|critical|must)\b/gi,
      core: /\b(core|fundamental|essential|basic)\b/gi,
      advanced: /\b(advanced|complex|sophisticated)\b/gi,
      automation: /\b(automation|automated|script|auto)\b/gi,
    };

    for (const [tag, pattern] of Object.entries(tagPatterns)) {
      if (content.match(pattern)) {
        tags.add(tag);
      }
    }

    // Filename-based tags
    if (filename.includes("router")) tags.add("router");
    if (filename.includes("protocol")) tags.add("protocol");
    if (filename.includes("management")) tags.add("management");
    if (filename.includes("guideline")) tags.add("guidelines");

    return Array.from(tags).slice(0, 8); // Reasonable limit
  }

  /**
   * Format rule name from filename
   */
  private formatRuleName(filename: string): string {
    return filename.replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
  }

  /**
   * Extract description from content
   */
  private extractDescription(content: string): string {
    const lines = content.split("\n");

    // Look for first paragraph after title
    let description = "";
    let foundTitle = false;

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith("#") && !foundTitle) {
        foundTitle = true;
        continue;
      }

      if (foundTitle && trimmed.length > 0 && !trimmed.startsWith("#")) {
        description = trimmed;
        break;
      }
    }

    return description || "No description available";
  }

  /**
   * Extract content themes across all rules
   */
  private extractContentThemes(rules: RuleMetadata[]): Record<string, number> {
    const themes: Record<string, number> = {};

    rules.forEach((rule) => {
      rule.content_themes.forEach((theme) => {
        themes[theme] = (themes[theme] || 0) + 1;
      });
    });

    return themes;
  }

  /**
   * Extract CLI commands across all rules
   */
  private extractCliCommands(rules: RuleMetadata[]): Record<string, number> {
    const commands: Record<string, number> = {};

    rules.forEach((rule) => {
      rule.cli_commands.forEach((cmd) => {
        const mainCmd = cmd.split(" ")[0];
        commands[mainCmd] = (commands[mainCmd] || 0) + 1;
      });
    });

    return commands;
  }

  /**
   * Suggest categories for all rules
   */
  private suggestCategories(rules: RuleMetadata[]): Record<string, string[]> {
    const suggestions: Record<string, string[]> = {};

    rules.forEach((rule) => {
      suggestions[rule.name] = rule.categories;
    });

    return suggestions;
  }

  /**
   * Calculate content redundancy between rules
   */
  private calculateRedundancy(
    rules: RuleMetadata[]
  ): Array<{ rule1: string; rule2: string; similarity: number }> {
    const redundancy: Array<{ rule1: string; rule2: string; similarity: number }> = [];

    for (let i = 0; i < rules.length; i++) {
      for (let j = i + 1; j < rules.length; j++) {
        const similarity = this.calculateSimilarity(rules[i], rules[j]);
        if (similarity > 0.3) {
          // Threshold for potential redundancy
          redundancy.push({
            rule1: rules[i].name,
            rule2: rules[j].name,
            similarity,
          });
        }
      }
    }

    return redundancy.sort((a, b) => b.similarity - a.similarity);
  }

  /**
   * Calculate similarity between two rules
   */
  private calculateSimilarity(rule1: RuleMetadata, rule2: RuleMetadata): number {
    // Simple similarity based on shared themes, commands, and categories
    const themes1 = new Set(rule1.content_themes);
    const themes2 = new Set(rule2.content_themes);
    const sharedThemes = new Set([...themes1].filter((x) => themes2.has(x)));

    const categories1 = new Set(rule1.categories);
    const categories2 = new Set(rule2.categories);
    const sharedCategories = new Set([...categories1].filter((x) => categories2.has(x)));

    const commands1 = new Set(rule1.cli_commands.map((c) => c.split(" ")[0]));
    const commands2 = new Set(rule2.cli_commands.map((c) => c.split(" ")[0]));
    const sharedCommands = new Set([...commands1].filter((x) => commands2.has(x)));

    const totalThemes = new Set([...themes1, ...themes2]).size;
    const totalCategories = new Set([...categories1, ...categories2]).size;
    const totalCommands = new Set([...commands1, ...commands2]).size;

    let similarity = 0;

    if (totalThemes > 0) similarity += (sharedThemes.size / totalThemes) * 0.4;
    if (totalCategories > 0) similarity += (sharedCategories.size / totalCategories) * 0.4;
    if (totalCommands > 0) similarity += (sharedCommands.size / totalCommands) * 0.2;

    return Math.min(similarity, 1.0);
  }

  /**
   * Analyze verbosity distribution
   */
  private analyzeVerbosity(rules: RuleMetadata[]): Record<number, number> {
    const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

    rules.forEach((rule) => {
      distribution[rule.verbosity_score]++;
    });

    return distribution;
  }
}

// Main execution
async function main() {
  const analyzer = new RuleAnalyzer();

  try {
    const results = await analyzer.analyzeRules();

    // Save results to JSON file
    const outputFile = "scripts/rule-analysis/analysis-results.json";
    await Bun.write(outputFile, JSON.stringify(results, null, 2));

    console.log(`\n📊 Analysis Results Summary:`);
    console.log(`- Total rules analyzed: ${results.total_rules}`);
    console.log(`- Content themes found: ${Object.keys(results.content_themes).length}`);
    console.log(`- CLI commands found: ${Object.keys(results.cli_commands).length}`);
    console.log(`- Potential redundancies: ${results.redundancy_matrix.length}`);
    console.log(`\n💾 Full results saved to: ${outputFile}`);
  } catch (error) {
    console.error("❌ Analysis failed:", error);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}

export { RuleAnalyzer };
export type { RuleMetadata, AnalysisResults };
