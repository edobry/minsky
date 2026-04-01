import * as path from "path";
import type { FileSystem } from "./file-system";
import { getMinskyRuleContent, getRulesIndexContent } from "./rule-templates";
import { getMCPConfigContent, getMCPRuleContent } from "./config-content";

export interface LegacyInitOptions {
  repoPath: string;
  backend: string;
  ruleFormat: "cursor" | "generic" | "minsky";
  mcp?: {
    enabled?: boolean;
    transport?: "stdio" | "sse" | "httpStream";
    port?: number;
    host?: string;
  };
  mcpOnly?: boolean;
  overwrite?: boolean;
}

/**
 * For testing: initialize a project with a custom filesystem implementation.
 * This function supports only the "tasks.md" backend (legacy test utility).
 */
export async function initializeProjectWithFS(
  options: LegacyInitOptions,
  fileSystem: FileSystem
): Promise<void> {
  const { repoPath, backend, ruleFormat, mcp, mcpOnly = false, overwrite = false } = options;

  // Handle different backends
  if (backend === "tasks.md") {
    // Initialize tasks.md backend
    if (!mcpOnly) {
      const tasksFilePath = path.join(repoPath, "process", "tasks.md");
      const tasksDirPath = path.join(repoPath, "process", "tasks");

      // Check if files exist
      if (fileSystem.existsSync(tasksFilePath) && !overwrite) {
        throw new Error(`File already exists: ${tasksFilePath}`);
      }

      // Create directories
      if (!fileSystem.existsSync(tasksDirPath)) {
        fileSystem.mkdirSync(tasksDirPath, { recursive: true });
      }

      // Create tasks.md file
      fileSystem.writeFileSync(tasksFilePath, "# Minsky Tasks\n\n- [ ] Example task\n");
    }

    // Handle rule format based on options
    const rulesDirPath = path.join(repoPath, ruleFormat === "cursor" ? ".cursor" : ".ai", "rules");

    // Create directories for rules
    if (!fileSystem.existsSync(rulesDirPath)) {
      fileSystem.mkdirSync(rulesDirPath, { recursive: true });
    }

    // Create rule files
    if (!mcpOnly) {
      const workflowRulePath = path.join(rulesDirPath, "minsky-workflow.mdc");
      const indexRulePath = path.join(rulesDirPath, "index.mdc");

      if (fileSystem.existsSync(workflowRulePath) && !overwrite) {
        throw new Error(`File already exists: ${workflowRulePath}`);
      }

      fileSystem.writeFileSync(workflowRulePath, getMinskyRuleContent());
      fileSystem.writeFileSync(indexRulePath, getRulesIndexContent());
    }

    // MCP Configuration
    if (mcp?.enabled !== false) {
      const mcpConfigPath = path.join(repoPath, ".cursor", "mcp.json");

      // Create .cursor directory if it doesn't exist (even for generic rule format)
      const cursorDirPath = path.join(repoPath, ".cursor");
      if (!fileSystem.existsSync(cursorDirPath)) {
        fileSystem.mkdirSync(cursorDirPath, { recursive: true });
      }

      if (fileSystem.existsSync(mcpConfigPath) && !overwrite) {
        throw new Error(`File already exists: ${mcpConfigPath}`);
      }

      // Create MCP config file
      fileSystem.writeFileSync(mcpConfigPath, getMCPConfigContent(mcp));

      // Create MCP usage rule
      const mcpRuleFilePath = path.join(rulesDirPath, "mcp-usage.mdc");
      if (!fileSystem.existsSync(mcpRuleFilePath) || overwrite) {
        fileSystem.writeFileSync(mcpRuleFilePath, getMCPRuleContent());
      }
    }
  } else if (backend === "tasks.csv") {
    throw new Error("The tasks.csv backend is not implemented yet.");
  } else {
    throw new Error(`Backend not implemented: ${backend}`);
  }
}
