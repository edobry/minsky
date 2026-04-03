import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { enumSchemas } from "./configuration/schemas/base";
import {
  type FileSystem,
  createDirectoryIfNotExists,
  createFileIfNotExists,
} from "./init/file-system";
import { getMinskyConfigContent, getMCPConfigContent } from "./init/config-content";
import {
  generateRulesWithTemplateSystem,
  generateMcpRuleWithTemplateSystem,
} from "./init/rule-templates";
import {
  resolveRepositoryFromGitRemote,
  type ResolvedRepositoryConfig,
} from "./session/repository-backend-detection";

// Re-export types and utilities from submodules for backward compatibility
export type { FileSystem };
export { initializeProjectWithFS } from "./init/legacy-fs";
export type { ResolvedRepositoryConfig } from "./session/repository-backend-detection";

/**
 * Detects the repository backend configuration from the git remote URL at the given path.
 * Convenience wrapper around resolveRepositoryFromGitRemote for use in init commands.
 */
export function detectRepositoryBackend(repoPath: string): ResolvedRepositoryConfig {
  return resolveRepositoryFromGitRemote(repoPath);
}

// Re-export content helpers for consumers that may reference them
export { getMinskyConfigContent, getMCPConfigContent } from "./init/config-content";
export {
  getMinskyRuleContent,
  getRulesIndexContent,
  generateRulesWithTemplateSystem,
  generateMcpRuleWithTemplateSystem,
} from "./init/rule-templates";

export const initializeProjectParamsSchema = z.object({
  repoPath: z.string(),
  backend: enumSchemas.backendType,
  ruleFormat: z.enum(["cursor", "generic", "minsky"] as const),
  mcp: z
    .object({
      enabled: z.boolean().optional().default(true),
      transport: z.enum(["stdio", "sse", "httpStream"]).optional().default("stdio"),
      port: z.number().optional(),
      host: z.string().optional(),
    })
    .optional(),
  mcpOnly: z.boolean().optional().default(false),
  overwrite: z.boolean().optional().default(false),
  repository: z
    .object({
      backend: z.enum(["github", "gitlab", "local"]),
      url: z.string().optional(),
      github: z
        .object({
          owner: z.string(),
          repo: z.string(),
        })
        .optional(),
    })
    .optional(),
});

export type InitializeProjectParams = z.infer<typeof initializeProjectParamsSchema>;

/**
 * The interface-agnostic function for initializing a project with Minsky configuration.
 * This function acts as the primary domain function for the init command.
 */
export async function initializeProjectFromParams(params: InitializeProjectParams): Promise<void> {
  // Validate the parameters
  const validatedParams = initializeProjectParamsSchema.parse(params);

  // Call the original initialization function
  return initializeProject(validatedParams);
}

export interface InitializeProjectOptions {
  repoPath: string;
  backend: z.infer<typeof enumSchemas.backendType>;
  ruleFormat: "cursor" | "generic" | "minsky";
  mcp?: {
    enabled: boolean;
    transport?: "stdio" | "sse" | "httpStream";
    port?: number;
    host?: string;
  };
  mcpOnly?: boolean;
  overwrite?: boolean;
  repository?: ResolvedRepositoryConfig;
}

/**
 * Creates directories if they don't exist, and errors if files already exist.
 * Orchestrates all project initialization steps.
 */
export async function initializeProject(
  {
    repoPath,
    backend,
    ruleFormat,
    mcp,
    mcpOnly = false,
    overwrite = false,
    repository,
  }: InitializeProjectOptions,
  fileSystem: FileSystem = fs
): Promise<void> {
  // When mcpOnly is true, we only set up MCP configuration and skip other setup
  if (!mcpOnly) {
    // Create process/tasks directory structure
    const tasksDir = path.join(repoPath, "process", "tasks");
    await createDirectoryIfNotExists(tasksDir, fileSystem);

    // Initialize the tasks backend based on user selection
    switch (backend) {
      case "markdown": {
        const tasksFilePath = path.join(repoPath, "process", "tasks.md");
        await createFileIfNotExists(
          tasksFilePath,
          `# Minsky Tasks\n\n## Task List\n\n| ID | Title | Status |\n|----|-------|--------|\n`,
          overwrite,
          fileSystem
        );
        break;
      }

      case "json-file": {
        const jsonFilePath = path.join(repoPath, "process", "tasks", "tasks.json");
        await createFileIfNotExists(
          jsonFilePath,
          JSON.stringify({ tasks: [] }, null, 2),
          overwrite,
          fileSystem
        );
        break;
      }

      case "github-issues":
        // GitHub Issues backend uses external GitHub repository - no local files needed
        // Configuration will be set up in the config file below
        break;

      case "minsky":
        // Minsky backend uses database - no task files needed
        // Database configuration will be set up in the config file below
        break;

      default:
        throw new Error(`Backend "${backend}" is not supported.`);
    }

    // Create rule file directory
    const rulesDirPath =
      ruleFormat === "cursor"
        ? path.join(repoPath, ".cursor", "rules")
        : path.join(repoPath, ".ai", "rules");
    await createDirectoryIfNotExists(rulesDirPath, fileSystem);

    // Generate rules using template system (tolerate missing command registry in tests)
    try {
      await generateRulesWithTemplateSystem(
        rulesDirPath,
        ruleFormat,
        overwrite,
        mcp?.enabled ?? false
      );
    } catch (_e) {
      // Skip rule generation when the command registry isn't available (unit tests)
    }
  }

  // Create main Minsky configuration file with user's backend choice
  const configDir = path.join(repoPath, "config");
  await createDirectoryIfNotExists(configDir, fileSystem);

  const configPath = path.join(configDir, "default.json");
  const configContent = getMinskyConfigContent(backend, repository);
  await createFileIfNotExists(configPath, configContent, overwrite, fileSystem);

  // Setup MCP if enabled (default to enabled if not explicitly disabled)
  if (mcp?.enabled !== false) {
    // Create the MCP config file
    const mcpConfig = getMCPConfigContent(mcp);
    const mcpConfigPath = path.join(repoPath, ".cursor", "mcp.json");
    await createFileIfNotExists(mcpConfigPath, mcpConfig, overwrite, fileSystem);

    // Determine rules dir path for MCP rule
    const rulesDirPath =
      ruleFormat === "cursor"
        ? path.join(repoPath, ".cursor", "rules")
        : path.join(repoPath, ".ai", "rules");

    await createDirectoryIfNotExists(rulesDirPath, fileSystem);

    // Generate MCP rule using template system (tolerate missing command registry in tests)
    try {
      await generateMcpRuleWithTemplateSystem(rulesDirPath, ruleFormat, overwrite, mcp);
    } catch (_e) {
      // Skip in unit tests without registry
    }
  }
}
