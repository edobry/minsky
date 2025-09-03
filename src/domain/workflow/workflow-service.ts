/**
 * Workflow Service
 *
 * Main service class that coordinates workflow assessment, configuration,
 * and management functionality.
 */

import fs from "fs/promises";
import path from "path";
import {
  parseWorkflowsConfig,
  ParsedWorkflowConfig,
  generateDefaultWorkflows,
  updateMinskyjsonWithWorkflows,
} from "./configuration";
import {
  performMaturityAssessment,
  MaturityAssessment,
  detectProjectInfo,
} from "./maturity-assessment";
import { BUILTIN_TOOLS, hasBuiltinTool, getBuiltinTool } from "./builtin-tools";
import { formatAssessment, formatWorkflowSummary } from "./output-formatters";

export class WorkflowService {
  constructor(private workspaceDir: string) {}

  /**
   * Get minsky.json path
   */
  private getMinskyjsonPath(): string {
    return path.join(this.workspaceDir, "minsky.json");
  }

  /**
   * Load existing minsky.json configuration
   */
  async loadMinskyjson(): Promise<Record<string, any>> {
    try {
      const content = await fs.readFile(this.getMinskyjsonPath(), "utf-8");
      return JSON.parse(content);
    } catch (error) {
      // File doesn't exist or invalid JSON, return empty config
      return {};
    }
  }

  /**
   * Save minsky.json configuration
   */
  async saveMinskyjson(config: Record<string, any>): Promise<void> {
    const content = JSON.stringify(config, null, 2);
    await fs.writeFile(this.getMinskyjsonPath(), content, "utf-8");
  }

  /**
   * Get currently configured workflows
   */
  async getConfiguredWorkflows(): Promise<ParsedWorkflowConfig[]> {
    const config = await this.loadMinskyjson();
    return parseWorkflowsConfig(config);
  }

  /**
   * Perform maturity assessment
   */
  async assess(format: "json" | "text" | "summary" = "text"): Promise<string> {
    const workflows = await this.getConfiguredWorkflows();
    const assessment = await performMaturityAssessment(workflows, this.workspaceDir);
    return formatAssessment(assessment, format);
  }

  /**
   * Initialize workflows based on project detection
   */
  async init(
    options: {
      interactive?: boolean;
      force?: boolean;
    } = {}
  ): Promise<string> {
    const { interactive = false, force = false } = options;

    // Detect project type
    const projectInfo = await detectProjectInfo(this.workspaceDir);
    const existingConfig = await this.loadMinskyjson();
    const existingWorkflows = parseWorkflowsConfig(existingConfig);

    if (existingWorkflows.length > 0 && !force) {
      return `Workflows already configured. Use --force to reinitialize.\\n\\n${formatWorkflowSummary(existingWorkflows)}`;
    }

    let results: string[] = [];
    results.push(`Detected project type: ${projectInfo.type || "unknown"}`);
    results.push("Found configuration files:");

    // Generate default workflows based on project type
    let defaultWorkflows: Record<string, any> = {};
    if (projectInfo.type) {
      defaultWorkflows = generateDefaultWorkflows(projectInfo.type);
    }

    // Detect existing configurations and suggest workflows
    const detectedWorkflows: Record<string, any> = {};

    if (projectInfo.hasEslintConfig && !defaultWorkflows.lint) {
      detectedWorkflows.lint = "eslint";
      results.push("  ✓ .eslintrc.js → Adding workflow: lint (eslint)");
    }

    if (projectInfo.hasPrettierConfig && !defaultWorkflows.format) {
      detectedWorkflows.format = "prettier";
      results.push("  ✓ .prettierrc → Adding workflow: format (prettier)");
    }

    if (projectInfo.hasJestConfig && !defaultWorkflows.test) {
      detectedWorkflows.test = "jest";
      results.push("  ✓ jest.config.js → Adding workflow: test (jest)");
    }

    if (projectInfo.hasTsConfig && !defaultWorkflows.typecheck) {
      detectedWorkflows.typecheck = "tsc";
      results.push("  ✓ tsconfig.json → Adding workflow: typecheck (tsc)");
    }

    // Combine default and detected workflows
    const finalWorkflows = { ...defaultWorkflows, ...detectedWorkflows };

    if (Object.keys(finalWorkflows).length === 0) {
      results.push("");
      results.push("No workflows could be automatically configured.");
      results.push("Run 'minsky workflow add <name> <tool>' to manually add workflows.");
      return results.join("\\n");
    }

    // In non-interactive mode, just apply the detected/default workflows
    if (!interactive) {
      const newConfig = updateMinskyjsonWithWorkflows(existingConfig, finalWorkflows);
      await this.saveMinskyjson(newConfig);

      results.push("");
      results.push("Configuration written to minsky.json");
      results.push("");
      results.push(formatWorkflowSummary(parseWorkflowsConfig(newConfig)));

      return results.join("\\n");
    }

    // TODO: Implement interactive mode with user prompts
    // For now, fall back to automatic mode
    const newConfig = updateMinskyjsonWithWorkflows(existingConfig, finalWorkflows);
    await this.saveMinskyjson(newConfig);

    results.push("");
    results.push("Configuration written to minsky.json");
    results.push("");
    results.push(formatWorkflowSummary(parseWorkflowsConfig(newConfig)));

    return results.join("\\n");
  }

  /**
   * Add a workflow
   */
  async addWorkflow(name: string, toolOrConfig: string | Record<string, any>): Promise<string> {
    const existingConfig = await this.loadMinskyjson();

    let workflowConfig: any;

    if (typeof toolOrConfig === "string") {
      // Simple tool name
      const toolName = toolOrConfig;

      if (hasBuiltinTool(toolName)) {
        workflowConfig = toolName;
      } else {
        workflowConfig = {
          custom: {
            run: toolName,
          },
        };
      }
    } else {
      // Complex configuration object
      workflowConfig = toolOrConfig;
    }

    const newWorkflows = { [name]: workflowConfig };
    const newConfig = updateMinskyjsonWithWorkflows(existingConfig, newWorkflows);

    await this.saveMinskyjson(newConfig);

    return `Added workflow: ${name}\\n\\nUpdated configuration written to minsky.json`;
  }

  /**
   * Run a workflow command
   */
  async runWorkflow(workflowName: string, command: string = "run"): Promise<string> {
    const workflows = await this.getConfiguredWorkflows();
    const workflow = workflows.find((w) => w.name === workflowName);

    if (!workflow) {
      return `Workflow '${workflowName}' not found. Available workflows: ${workflows.map((w) => w.name).join(", ")}`;
    }

    const cmd = workflow.commands[command];
    if (!cmd) {
      const availableCommands = Object.keys(workflow.commands);
      return `Command '${command}' not available for workflow '${workflowName}'. Available commands: ${availableCommands.join(", ")}`;
    }

    return `Would execute: ${cmd}\\n\\n(Note: Actual command execution not implemented in this version)`;
  }

  /**
   * List all available built-in tools
   */
  async listBuiltinTools(): Promise<string> {
    const lines: string[] = [];
    lines.push("Available Built-in Tools:");
    lines.push("========================");
    lines.push("");

    for (const [toolName, tool] of Object.entries(BUILTIN_TOOLS)) {
      lines.push(`${toolName} - ${tool.description}`);
      const commands = Object.keys(tool.commands);
      if (commands.length > 0) {
        lines.push(`  Commands: ${commands.join(", ")}`);
      }
      lines.push(`  Categories: ${tool.categories.join(", ")}`);
      lines.push("");
    }

    return lines.join("\\n");
  }

  /**
   * Get workflow status summary
   */
  async getStatus(): Promise<string> {
    const workflows = await this.getConfiguredWorkflows();
    const assessment = await performMaturityAssessment(workflows, this.workspaceDir);

    const lines: string[] = [];
    lines.push(`Maturity Score: ${Math.round(assessment.score * 100)}% (${assessment.grade})`);
    lines.push("");
    lines.push(formatWorkflowSummary(workflows));

    if (assessment.recommendations.length > 0) {
      lines.push("");
      lines.push("Top Recommendations:");
      assessment.recommendations.slice(0, 3).forEach((rec, index) => {
        lines.push(`${index + 1}. ${rec.action}`);
      });
    }

    return lines.join("\\n");
  }
}
