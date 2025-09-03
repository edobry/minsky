/**
 * Workflow Assessment Output Formatters
 *
 * Provides both human-friendly and machine-readable output formats
 * for maturity assessment results.
 */

import { MaturityAssessment, CategoryAssessment } from "./maturity-assessment";

/**
 * Generate progress bar visualization
 */
function createProgressBar(score: number, width: number = 10): string {
  const filled = Math.round(score * width);
  const empty = width - filled;
  return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
}

/**
 * Format score as percentage
 */
function formatPercentage(score: number): string {
  return `${Math.round(score * 100)}%`;
}

/**
 * Format category assessment for human-readable output
 */
function formatCategoryAssessment(name: string, assessment: CategoryAssessment): string {
  const lines: string[] = [];
  const progressBar = createProgressBar(assessment.score);
  const percentage = formatPercentage(assessment.score);

  lines.push(`${name.padEnd(25)} ${progressBar} ${percentage}`);

  // Add configured items
  for (const [key, item] of Object.entries(assessment.items)) {
    const status = item.configured ? "✓" : "✗";
    const tool = item.tool ? ` (${item.tool})` : "";
    const description = item.description ? ` - ${item.description}` : "";
    lines.push(`  ${status} ${item.name}${tool}${description}`);
  }

  return lines.join("\\n");
}

/**
 * Format full maturity assessment as human-readable text
 */
export function formatHumanReadableAssessment(assessment: MaturityAssessment): string {
  const lines: string[] = [];

  // Header
  lines.push("Development Workflow Maturity Assessment");
  lines.push("=========================================");
  lines.push("");

  // Category assessments
  for (const [categoryName, categoryAssessment] of Object.entries(assessment.categories)) {
    lines.push(formatCategoryAssessment(categoryName, categoryAssessment));
    lines.push("");
  }

  // Overall score
  const overallBar = createProgressBar(assessment.score);
  const overallPercentage = formatPercentage(assessment.score);
  lines.push(`Overall Maturity Score: ${overallPercentage} (${assessment.grade})`);
  lines.push("");

  // Recommendations
  if (assessment.recommendations.length > 0) {
    lines.push("Recommendations:");
    assessment.recommendations.forEach((rec, index) => {
      const command = rec.command ? `: ${rec.command}` : "";
      lines.push(`${index + 1}. ${rec.action}${command}`);
    });
    lines.push("");
  }

  // Footer
  lines.push("Run 'minsky workflow init' for interactive setup");

  return lines.join("\\n");
}

/**
 * Format assessment as JSON
 */
export function formatJsonAssessment(assessment: MaturityAssessment): string {
  return JSON.stringify(assessment, null, 2);
}

/**
 * Format category summary for quick overview
 */
export function formatCategorySummary(assessment: MaturityAssessment): string {
  const lines: string[] = [];

  for (const [categoryName, categoryAssessment] of Object.entries(assessment.categories)) {
    const percentage = formatPercentage(categoryAssessment.score);
    const progressBar = createProgressBar(categoryAssessment.score, 5);
    lines.push(`${categoryName.padEnd(20)} ${progressBar} ${percentage}`);
  }

  return lines.join("\\n");
}

/**
 * Format just the recommendations
 */
export function formatRecommendations(assessment: MaturityAssessment): string {
  if (assessment.recommendations.length === 0) {
    return "No recommendations - your workflow maturity is excellent!";
  }

  const lines: string[] = [];
  lines.push("Recommended Actions:");
  lines.push("");

  assessment.recommendations.forEach((rec, index) => {
    lines.push(`${index + 1}. [${rec.category}] ${rec.action}`);
    if (rec.command) {
      lines.push(`   Command: ${rec.command}`);
    }
    lines.push("");
  });

  return lines.join("\\n");
}

/**
 * Format assessment based on requested format
 */
export function formatAssessment(
  assessment: MaturityAssessment,
  format: "json" | "text" | "summary" = "text"
): string {
  switch (format) {
    case "json":
      return formatJsonAssessment(assessment);
    case "summary":
      return formatCategorySummary(assessment);
    case "text":
    default:
      return formatHumanReadableAssessment(assessment);
  }
}

/**
 * Format workflow configuration summary
 */
export function formatWorkflowSummary(
  workflows: Array<{
    name: string;
    type: "builtin" | "custom";
    tool?: string;
    commands: Record<string, string>;
  }>
): string {
  if (workflows.length === 0) {
    return "No workflows configured.\\n\\nRun 'minsky workflow init' to get started.";
  }

  const lines: string[] = [];
  lines.push("Configured Workflows:");
  lines.push("====================");
  lines.push("");

  workflows.forEach((workflow) => {
    const type = workflow.type === "builtin" ? "Built-in" : "Custom";
    const tool = workflow.tool ? ` (${workflow.tool})` : "";
    lines.push(`${workflow.name}${tool} - ${type}`);

    const commands = Object.keys(workflow.commands);
    if (commands.length > 0) {
      lines.push(`  Commands: ${commands.join(", ")}`);
    }
    lines.push("");
  });

  return lines.join("\\n");
}
