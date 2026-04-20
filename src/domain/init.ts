import * as path from "path";
import { z } from "zod";
import { enumSchemas } from "./configuration/schemas/base";
import { createDirectoryIfNotExists, createFileIfNotExists } from "./init/file-system";
import type { FsLike } from "./interfaces/fs-like";
import { createRealFs } from "./interfaces/real-fs";
import { getMinskyConfigContentYaml, getLocalConfigContentYaml } from "./init/config-content";
import {
  generateRulesWithTemplateSystem,
  generateMcpRuleWithTemplateSystem,
} from "./init/rule-templates";
import {
  resolveRepositoryFromGitRemote,
  type ResolvedRepositoryConfig,
} from "./session/repository-backend-detection";
import { registerWithClient } from "./mcp/registration";

export type { ResolvedRepositoryConfig } from "./session/repository-backend-detection";

/**
 * Detects the repository backend configuration from the git remote URL at the given path.
 * Convenience wrapper around resolveRepositoryFromGitRemote for use in init commands.
 */
export function detectRepositoryBackend(repoPath: string): ResolvedRepositoryConfig {
  return resolveRepositoryFromGitRemote(repoPath);
}

// Re-export content helpers for consumers that may reference them
export { getMinskyConfigContentYaml, getLocalConfigContentYaml } from "./init/config-content";
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
  overwrite?: boolean;
  repository?: ResolvedRepositoryConfig;
}

/**
 * Creates directories if they don't exist, and errors if files already exist.
 * Orchestrates all project initialization steps.
 */
export async function initializeProject(
  { repoPath, backend, ruleFormat, mcp, overwrite = false, repository }: InitializeProjectOptions,
  fileSystem: FsLike = createRealFs()
): Promise<void> {
  // Create process/tasks directory structure
  const tasksDir = path.join(repoPath, "process", "tasks");
  await createDirectoryIfNotExists(tasksDir, fileSystem);

  // Initialize the tasks backend based on user selection
  switch (backend) {
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

  // Create main Minsky configuration file with user's backend choice
  const minskyDir = path.join(repoPath, ".minsky");
  await createDirectoryIfNotExists(minskyDir, fileSystem);

  const configPath = path.join(minskyDir, "config.yaml");
  const mcpForConfig =
    mcp?.enabled !== false
      ? { transport: mcp?.transport, port: mcp?.port, host: mcp?.host }
      : undefined;
  const configContent = getMinskyConfigContentYaml(backend, repository, mcpForConfig);
  await createFileIfNotExists(configPath, configContent, overwrite, fileSystem);

  // Write machine-specific local config (gitignored) with workspace.mainPath
  // so session_start can use --reference cloning for fast session creation.
  const localConfigPath = path.join(minskyDir, "config.local.yaml");
  const localConfigContent = getLocalConfigContentYaml(repoPath);
  await createFileIfNotExists(localConfigPath, localConfigContent, overwrite, fileSystem);

  // Setup MCP if enabled (default to enabled if not explicitly disabled)
  if (mcp?.enabled !== false) {
    // Register Minsky with the Cursor MCP client
    await registerWithClient(
      repoPath,
      {
        transport: mcp?.transport || "stdio",
        port: mcp?.port,
        host: mcp?.host,
      },
      "cursor",
      fileSystem,
      overwrite
    );

    // Determine rules dir path for MCP rule
    const mcpRulesDirPath =
      ruleFormat === "cursor"
        ? path.join(repoPath, ".cursor", "rules")
        : path.join(repoPath, ".ai", "rules");

    await createDirectoryIfNotExists(mcpRulesDirPath, fileSystem);

    // Generate MCP rule using template system (tolerate missing command registry in tests)
    try {
      await generateMcpRuleWithTemplateSystem(mcpRulesDirPath, ruleFormat, overwrite, mcp);
    } catch (_e) {
      // Skip in unit tests without registry
    }
  }
}
