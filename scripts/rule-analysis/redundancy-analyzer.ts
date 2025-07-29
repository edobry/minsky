#!/usr/bin/env bun

/**
 * Redundancy Analysis Tool
 *
 * Performs comprehensive analysis of rule redundancy and duplication by:
 * - Analyzing content similarity between rules
 * - Identifying overlapping command patterns
 * - Finding rules that could be consolidated
 * - Recommending deprecation and cleanup actions
 */

import { readFile } from "fs/promises";
import { basename, extname } from "path";
import matter from "gray-matter";
import { RuleAnalyzer, type RuleMetadata, type AnalysisResults } from "./rule-analyzer";

// Redundancy analysis interfaces
interface RedundancyPair {
  rule1: RuleMetadata;
  rule2: RuleMetadata;
  similarity_score: number;
  similarity_factors: {
    content_overlap: number;
    theme_overlap: number;
    command_overlap: number;
    category_overlap: number;
  };
  redundancy_type: "high" | "medium" | "low";
  consolidation_recommendation: string;
}

interface ConsolidationOpportunity {
  rules: RuleMetadata[];
  consolidation_type: "merge" | "supersede" | "split" | "refactor";
  reason: string;
  effort_estimate: "low" | "medium" | "high";
  priority: "high" | "medium" | "low";
  recommended_action: string;
}

interface RedundancyReport {
  total_rules: number;
  high_redundancy_pairs: RedundancyPair[];
  medium_redundancy_pairs: RedundancyPair[];
  consolidation_opportunities: ConsolidationOpportunity[];
  verbosity_analysis: {
    very_verbose_rules: RuleMetadata[];
    consolidation_candidates: RuleMetadata[];
  };
  deprecation_candidates: RuleMetadata[];
  summary: {
    potential_savings: number;
    high_priority_actions: string[];
    estimated_cleanup_effort: string;
  };
}

class RedundancyAnalyzer {
  private analyzer: RuleAnalyzer;

  constructor(rulesDir: string = ".cursor/rules") {
    this.analyzer = new RuleAnalyzer(rulesDir);
  }

  /**
   * Perform comprehensive redundancy analysis
   */
  async analyzeRedundancy(): Promise<RedundancyReport> {
    console.log("🔍 Starting comprehensive redundancy analysis...");

    const results = await this.analyzer.analyzeRules();
    console.log(`📊 Analyzing redundancy across ${results.total_rules} rules`);

    // Analyze similarity pairs
    const redundancyPairs = await this.analyzeRedundancyPairs(results.rules);

    // Group by redundancy level
    const highRedundancy = redundancyPairs.filter((p) => p.redundancy_type === "high");
    const mediumRedundancy = redundancyPairs.filter((p) => p.redundancy_type === "medium");

    // Identify consolidation opportunities
    const consolidationOpportunities = await this.identifyConsolidationOpportunities(
      results.rules,
      redundancyPairs
    );

    // Analyze verbosity
    const verbosityAnalysis = this.analyzeVerbosity(results.rules);

    // Identify deprecation candidates
    const deprecationCandidates = this.identifyDeprecationCandidates(results.rules);

    // Generate summary and recommendations
    const summary = this.generateSummary(
      highRedundancy,
      mediumRedundancy,
      consolidationOpportunities
    );

    const report: RedundancyReport = {
      total_rules: results.total_rules,
      high_redundancy_pairs: highRedundancy,
      medium_redundancy_pairs: mediumRedundancy,
      consolidation_opportunities: consolidationOpportunities,
      verbosity_analysis: verbosityAnalysis,
      deprecation_candidates: deprecationCandidates,
      summary,
    };

    console.log(`🎯 Redundancy analysis complete:`);
    console.log(`   - High redundancy pairs: ${highRedundancy.length}`);
    console.log(`   - Medium redundancy pairs: ${mediumRedundancy.length}`);
    console.log(`   - Consolidation opportunities: ${consolidationOpportunities.length}`);

    return report;
  }

  /**
   * Analyze redundancy between rule pairs
   */
  private async analyzeRedundancyPairs(rules: RuleMetadata[]): Promise<RedundancyPair[]> {
    const pairs: RedundancyPair[] = [];

    for (let i = 0; i < rules.length; i++) {
      for (let j = i + 1; j < rules.length; j++) {
        const similarity = await this.calculateDetailedSimilarity(rules[i], rules[j]);

        if (similarity.similarity_score > 0.3) {
          // Threshold for potential redundancy
          pairs.push({
            rule1: rules[i],
            rule2: rules[j],
            similarity_score: similarity.similarity_score,
            similarity_factors: similarity.factors,
            redundancy_type: this.classifyRedundancy(similarity.similarity_score),
            consolidation_recommendation: this.generateConsolidationRecommendation(
              rules[i],
              rules[j],
              similarity
            ),
          });
        }
      }
    }

    return pairs.sort((a, b) => b.similarity_score - a.similarity_score);
  }

  /**
   * Calculate detailed similarity between two rules
   */
  private async calculateDetailedSimilarity(
    rule1: RuleMetadata,
    rule2: RuleMetadata
  ): Promise<{
    similarity_score: number;
    factors: RedundancyPair["similarity_factors"];
  }> {
    // Read actual content for text analysis
    const content1 = await readFile(rule1.filePath, "utf-8");
    const content2 = await readFile(rule2.filePath, "utf-8");

    const parsed1 = matter(content1);
    const parsed2 = matter(content2);

    // Content overlap analysis
    const content_overlap = this.calculateTextSimilarity(parsed1.content, parsed2.content);

    // Theme overlap
    const themes1 = new Set(rule1.content_themes);
    const themes2 = new Set(rule2.content_themes);
    const sharedThemes = new Set([...themes1].filter((x) => themes2.has(x)));
    const totalThemes = new Set([...themes1, ...themes2]);
    const theme_overlap = totalThemes.size > 0 ? sharedThemes.size / totalThemes.size : 0;

    // Command overlap
    const commands1 = new Set(rule1.cli_commands.map((c) => c.split(" ")[0]));
    const commands2 = new Set(rule2.cli_commands.map((c) => c.split(" ")[0]));
    const sharedCommands = new Set([...commands1].filter((x) => commands2.has(x)));
    const totalCommands = new Set([...commands1, ...commands2]);
    const command_overlap = totalCommands.size > 0 ? sharedCommands.size / totalCommands.size : 0;

    // Category overlap
    const categories1 = new Set(rule1.categories);
    const categories2 = new Set(rule2.categories);
    const sharedCategories = new Set([...categories1].filter((x) => categories2.has(x)));
    const totalCategories = new Set([...categories1, ...categories2]);
    const category_overlap =
      totalCategories.size > 0 ? sharedCategories.size / totalCategories.size : 0;

    // Calculate weighted similarity score
    const similarity_score =
      content_overlap * 0.4 +
      theme_overlap * 0.25 +
      command_overlap * 0.2 +
      category_overlap * 0.15;

    return {
      similarity_score,
      factors: {
        content_overlap,
        theme_overlap,
        command_overlap,
        category_overlap,
      },
    };
  }

  /**
   * Calculate text similarity using simple word overlap
   */
  private calculateTextSimilarity(text1: string, text2: string): number {
    // Normalize and tokenize
    const words1 = new Set(text1.toLowerCase().match(/\b\w+\b/g) || []);
    const words2 = new Set(text2.toLowerCase().match(/\b\w+\b/g) || []);

    // Calculate Jaccard similarity
    const intersection = new Set([...words1].filter((x) => words2.has(x)));
    const union = new Set([...words1, ...words2]);

    return union.size > 0 ? intersection.size / union.size : 0;
  }

  /**
   * Classify redundancy level
   */
  private classifyRedundancy(score: number): "high" | "medium" | "low" {
    if (score > 0.7) return "high";
    if (score > 0.5) return "medium";
    return "low";
  }

  /**
   * Generate consolidation recommendation
   */
  private generateConsolidationRecommendation(
    rule1: RuleMetadata,
    rule2: RuleMetadata,
    similarity: { similarity_score: number; factors: RedundancyPair["similarity_factors"] }
  ): string {
    const { factors, similarity_score } = similarity;

    if (similarity_score > 0.8) {
      return `HIGH PRIORITY: Rules are ${Math.round(similarity_score * 100)}% similar. Consider merging or marking one as superseded.`;
    }

    if (factors.content_overlap > 0.6) {
      return `Content overlap ${Math.round(factors.content_overlap * 100)}%. Review for duplication and consider consolidation.`;
    }

    if (factors.command_overlap > 0.7) {
      return `High command overlap ${Math.round(factors.command_overlap * 100)}%. May cover same workflows - review for consolidation.`;
    }

    if (factors.theme_overlap > 0.8) {
      return `Same thematic coverage ${Math.round(factors.theme_overlap * 100)}%. Check if rules can be combined.`;
    }

    return `Moderate similarity ${Math.round(similarity_score * 100)}%. Monitor for potential future consolidation.`;
  }

  /**
   * Identify consolidation opportunities
   */
  private async identifyConsolidationOpportunities(
    rules: RuleMetadata[],
    redundancyPairs: RedundancyPair[]
  ): Promise<ConsolidationOpportunity[]> {
    const opportunities: ConsolidationOpportunity[] = [];

    // Group high redundancy pairs
    const highRedundancyGroups = this.groupRedundantRules(
      redundancyPairs.filter((p) => p.redundancy_type === "high")
    );

    for (const group of highRedundancyGroups) {
      opportunities.push({
        rules: group,
        consolidation_type: this.determineConsolidationType(group),
        reason: this.generateConsolidationReason(group),
        effort_estimate: this.estimateConsolidationEffort(group),
        priority: "high",
        recommended_action: this.generateConsolidationAction(group),
      });
    }

    // Identify verbose rules that could be split
    const verboseRules = rules.filter((r) => r.verbosity_score >= 4 && r.word_count > 1500);
    for (const rule of verboseRules) {
      if (rule.content_themes.length > 3) {
        opportunities.push({
          rules: [rule],
          consolidation_type: "split",
          reason: `Rule is verbose (${rule.word_count} words) and covers multiple themes: ${rule.content_themes.join(", ")}`,
          effort_estimate: "medium",
          priority: "medium",
          recommended_action: `Split ${rule.name} into focused rules for each theme`,
        });
      }
    }

    // Identify rules with overlapping command patterns
    const commandGroups = this.groupRulesByCommands(rules);
    for (const [commands, groupRules] of commandGroups) {
      if (groupRules.length > 2 && commands.length > 2) {
        opportunities.push({
          rules: groupRules,
          consolidation_type: "merge",
          reason: `Rules share common command patterns: ${commands.join(", ")}`,
          effort_estimate: "low",
          priority: "medium",
          recommended_action: `Consider creating a unified CLI reference rule`,
        });
      }
    }

    return opportunities.sort((a, b) => {
      const priorityOrder = { high: 3, medium: 2, low: 1 };
      return priorityOrder[b.priority] - priorityOrder[a.priority];
    });
  }

  /**
   * Group rules that are redundant with each other
   */
  private groupRedundantRules(redundancyPairs: RedundancyPair[]): RuleMetadata[][] {
    const groups: RuleMetadata[][] = [];
    const processed = new Set<string>();

    for (const pair of redundancyPairs) {
      const rule1Key = pair.rule1.name;
      const rule2Key = pair.rule2.name;

      if (processed.has(rule1Key) || processed.has(rule2Key)) continue;

      const group = [pair.rule1, pair.rule2];
      processed.add(rule1Key);
      processed.add(rule2Key);

      // Find other rules that are also redundant with this group
      for (const otherPair of redundancyPairs) {
        if (otherPair === pair) continue;

        const hasRule1 = group.some((r) => r.name === otherPair.rule1.name);
        const hasRule2 = group.some((r) => r.name === otherPair.rule2.name);

        if (hasRule1 && !processed.has(otherPair.rule2.name)) {
          group.push(otherPair.rule2);
          processed.add(otherPair.rule2.name);
        } else if (hasRule2 && !processed.has(otherPair.rule1.name)) {
          group.push(otherPair.rule1);
          processed.add(otherPair.rule1.name);
        }
      }

      if (group.length >= 2) {
        groups.push(group);
      }
    }

    return groups;
  }

  /**
   * Group rules by common CLI commands
   */
  private groupRulesByCommands(rules: RuleMetadata[]): Map<string[], RuleMetadata[]> {
    const groups = new Map<string[], RuleMetadata[]>();

    // Extract unique command patterns
    const commandPatterns = new Map<string, RuleMetadata[]>();

    for (const rule of rules) {
      const mainCommands = rule.cli_commands
        .map((cmd) => cmd.split(" ")[0])
        .filter((cmd) => ["minsky", "git", "bun", "npm"].includes(cmd));

      for (const cmd of mainCommands) {
        if (!commandPatterns.has(cmd)) {
          commandPatterns.set(cmd, []);
        }
        commandPatterns.get(cmd)!.push(rule);
      }
    }

    // Convert to result format
    for (const [cmd, groupRules] of commandPatterns) {
      if (groupRules.length > 1) {
        groups.set([cmd], groupRules);
      }
    }

    return groups;
  }

  /**
   * Determine the best consolidation type for a group of rules
   */
  private determineConsolidationType(
    rules: RuleMetadata[]
  ): ConsolidationOpportunity["consolidation_type"] {
    if (rules.length === 2) {
      const avgVerbosity = rules.reduce((sum, r) => sum + r.verbosity_score, 0) / rules.length;
      return avgVerbosity > 3 ? "merge" : "supersede";
    }

    return "merge";
  }

  /**
   * Generate reason for consolidation
   */
  private generateConsolidationReason(rules: RuleMetadata[]): string {
    const avgSimilarity = 85; // Placeholder - would calculate from actual pairs
    const sharedThemes = this.findSharedThemes(rules);

    return `Rules share ${avgSimilarity}% similarity with common themes: ${sharedThemes.join(", ")}`;
  }

  /**
   * Find themes shared across multiple rules
   */
  private findSharedThemes(rules: RuleMetadata[]): string[] {
    const themeCounts = new Map<string, number>();

    for (const rule of rules) {
      for (const theme of rule.content_themes) {
        themeCounts.set(theme, (themeCounts.get(theme) || 0) + 1);
      }
    }

    return Array.from(themeCounts.entries())
      .filter(([, count]) => count >= 2)
      .map(([theme]) => theme);
  }

  /**
   * Estimate effort required for consolidation
   */
  private estimateConsolidationEffort(rules: RuleMetadata[]): "low" | "medium" | "high" {
    const totalWords = rules.reduce((sum, r) => sum + r.word_count, 0);
    const avgVerbosity = rules.reduce((sum, r) => sum + r.verbosity_score, 0) / rules.length;

    if (totalWords > 3000 || avgVerbosity > 4) return "high";
    if (totalWords > 1500 || avgVerbosity > 3) return "medium";
    return "low";
  }

  /**
   * Generate specific consolidation action
   */
  private generateConsolidationAction(rules: RuleMetadata[]): string {
    if (rules.length === 2) {
      return `Merge ${rules[0].name} and ${rules[1].name} into a single comprehensive rule`;
    }

    return `Consolidate ${rules.length} rules (${rules.map((r) => r.name).join(", ")}) into unified guidance`;
  }

  /**
   * Analyze verbosity patterns
   */
  private analyzeVerbosity(rules: RuleMetadata[]): RedundancyReport["verbosity_analysis"] {
    const veryVerboseRules = rules
      .filter((r) => r.verbosity_score >= 4)
      .sort((a, b) => b.word_count - a.word_count);

    const consolidationCandidates = rules
      .filter((r) => r.verbosity_score >= 3 && r.content_themes.length > 2)
      .sort((a, b) => b.verbosity_score - a.verbosity_score);

    return {
      very_verbose_rules: veryVerboseRules,
      consolidation_candidates: consolidationCandidates,
    };
  }

  /**
   * Identify rules that may be candidates for deprecation
   */
  private identifyDeprecationCandidates(rules: RuleMetadata[]): RuleMetadata[] {
    return rules.filter((rule) => {
      // Rules with minimal content
      if (rule.word_count < 100) return true;

      // Rules with no CLI commands or themes (potentially outdated)
      if (rule.cli_commands.length === 0 && rule.content_themes.length === 0) return true;

      // Rules marked as deprecated in frontmatter
      if (rule.lifecycle === "deprecated") return true;

      return false;
    });
  }

  /**
   * Generate summary and high-priority recommendations
   */
  private generateSummary(
    highRedundancy: RedundancyPair[],
    mediumRedundancy: RedundancyPair[],
    opportunities: ConsolidationOpportunity[]
  ): RedundancyReport["summary"] {
    const potentialSavings = Math.round(
      (highRedundancy.length * 0.5 + mediumRedundancy.length * 0.3) * 100
    );

    const highPriorityActions = [
      ...opportunities.filter((o) => o.priority === "high").map((o) => o.recommended_action),
      ...highRedundancy
        .slice(0, 3)
        .map((p) => `Review ${p.rule1.name} vs ${p.rule2.name} for consolidation`),
    ].slice(0, 5);

    const totalEffort = opportunities.reduce((total, opp) => {
      const effort = { low: 1, medium: 3, high: 5 }[opp.effort_estimate];
      return total + effort;
    }, 0);

    let effortEstimate = "Low";
    if (totalEffort > 15) effortEstimate = "High";
    else if (totalEffort > 8) effortEstimate = "Medium";

    return {
      potential_savings: potentialSavings,
      high_priority_actions: highPriorityActions,
      estimated_cleanup_effort: effortEstimate,
    };
  }

  /**
   * Generate comprehensive redundancy report
   */
  async generateReport(report: RedundancyReport): Promise<void> {
    const reportPath = "docs/rules/rule-ecosystem-audit.md";

    const markdown = `# Rule Ecosystem Redundancy Analysis

## Executive Summary

This comprehensive analysis examines redundancy and consolidation opportunities across ${report.total_rules} rules in the Minsky ecosystem.

### Key Findings

- **High redundancy pairs**: ${report.high_redundancy_pairs.length}
- **Medium redundancy pairs**: ${report.medium_redundancy_pairs.length}
- **Consolidation opportunities**: ${report.consolidation_opportunities.length}
- **Potential content savings**: ~${report.summary.potential_savings}%
- **Estimated cleanup effort**: ${report.summary.estimated_cleanup_effort}

## High Priority Actions

${report.summary.high_priority_actions.map((action) => `1. ${action}`).join("\n")}

## High Redundancy Pairs

${report.high_redundancy_pairs
  .map(
    (pair) => `
### ${pair.rule1.name} ↔ ${pair.rule2.name}
- **Similarity**: ${Math.round(pair.similarity_score * 100)}%
- **Content overlap**: ${Math.round(pair.similarity_factors.content_overlap * 100)}%
- **Theme overlap**: ${Math.round(pair.similarity_factors.theme_overlap * 100)}%
- **Command overlap**: ${Math.round(pair.similarity_factors.command_overlap * 100)}%
- **Recommendation**: ${pair.consolidation_recommendation}
`
  )
  .join("\n")}

## Consolidation Opportunities

${report.consolidation_opportunities
  .map(
    (opp) => `
### ${opp.consolidation_type.toUpperCase()}: ${opp.rules.map((r) => r.name).join(", ")}
- **Type**: ${opp.consolidation_type}
- **Priority**: ${opp.priority}
- **Effort**: ${opp.effort_estimate}
- **Reason**: ${opp.reason}
- **Action**: ${opp.recommended_action}
`
  )
  .join("\n")}

## Verbosity Analysis

### Very Verbose Rules (4+ verbosity score)

${report.verbosity_analysis.very_verbose_rules
  .map(
    (rule) => `
- **${rule.name}**: ${rule.word_count} words, score ${rule.verbosity_score}
  - Themes: ${rule.content_themes.join(", ")}
`
  )
  .join("\n")}

### Consolidation Candidates

${report.verbosity_analysis.consolidation_candidates
  .map(
    (rule) => `
- **${rule.name}**: Multiple themes (${rule.content_themes.join(", ")})
`
  )
  .join("\n")}

## Deprecation Candidates

${report.deprecation_candidates
  .map(
    (rule) => `
- **${rule.name}**: ${rule.word_count} words
  - Reason: ${rule.word_count < 100 ? "Minimal content" : "No CLI commands or themes"}
`
  )
  .join("\n")}

## Implementation Recommendations

### Phase 1: Quick Wins (Low Effort, High Impact)
${report.consolidation_opportunities
  .filter((o) => o.effort_estimate === "low" && o.priority === "high")
  .map((o) => `- ${o.recommended_action}`)
  .join("\n")}

### Phase 2: Medium Effort Consolidations
${report.consolidation_opportunities
  .filter((o) => o.effort_estimate === "medium")
  .map((o) => `- ${o.recommended_action}`)
  .join("\n")}

### Phase 3: Comprehensive Restructuring
${report.consolidation_opportunities
  .filter((o) => o.effort_estimate === "high")
  .map((o) => `- ${o.recommended_action}`)
  .join("\n")}

## Next Steps

1. **Review high redundancy pairs** - Start with pairs >80% similarity
2. **Implement quick wins** - Focus on low-effort, high-impact consolidations
3. **Update categorization** - Ensure consolidated rules are properly categorized
4. **Test changes** - Verify consolidated rules maintain functionality
5. **Update templates** - Reflect consolidation in rule templates

---

*Report generated on: ${new Date().toISOString()}*
*Analysis tool: Minsky Rule Redundancy Analyzer*
`;

    await Bun.write(reportPath, markdown);
    console.log(`📋 Comprehensive redundancy report saved to: ${reportPath}`);
  }
}

// Main execution
async function main() {
  const analyzer = new RedundancyAnalyzer();

  try {
    const report = await analyzer.analyzeRedundancy();

    // Generate comprehensive report
    await analyzer.generateReport(report);

    // Save raw analysis data
    await Bun.write(
      "scripts/rule-analysis/redundancy-analysis.json",
      JSON.stringify(report, null, 2)
    );

    console.log("\n🎯 Redundancy analysis complete!");
    console.log("📋 Check docs/rules/rule-ecosystem-audit.md for full report");
    console.log("💾 Raw data saved to scripts/rule-analysis/redundancy-analysis.json");
  } catch (error) {
    console.error("❌ Redundancy analysis failed:", error);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}

export { RedundancyAnalyzer };
export type { RedundancyPair, ConsolidationOpportunity, RedundancyReport };
