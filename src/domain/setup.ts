/**
 * Setup domain function.
 *
 * Performs developer-local initialization: reads the existing project config
 * and derives local configuration (MCP registration + local config file).
 * Unlike `init`, this works with an already-initialized project and does
 * not require full config system initialization.
 */

import * as path from "path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import type { FsLike } from "./interfaces/fs-like";
import { createRealFs } from "./interfaces/real-fs";
import { createFileIfNotExists } from "./init/file-system";
import { registerWithClient, getRegistrar } from "./mcp/registration";

export interface SetupOptions {
  repoPath: string;
  client?: string;
  overwrite?: boolean;
}

export interface SetupResult {
  success: boolean;
  localConfigPath: string;
  harnessConfigPath: string;
  client: string;
  message: string;
}

interface MinimalMcpConfig {
  transport?: string;
  port?: number;
  host?: string;
}

interface MinimalProjectConfig {
  mcp?: MinimalMcpConfig;
}

/**
 * Perform developer-local setup for a Minsky project.
 *
 * Steps:
 * 1. Check .minsky/config.yaml exists — error if not
 * 2. Read and parse it (use yaml.parse)
 * 3. Extract mcp section (default to { transport: "stdio" } if missing)
 * 4. Call registerWithClient() to write the harness config file
 * 5. Write .minsky/config.local.yaml with workspace.mainPath AND harness field
 * 6. Return result describing what was written
 */
export async function performSetup(
  options: SetupOptions,
  fileSystem: FsLike = createRealFs()
): Promise<SetupResult> {
  const { repoPath, client = "cursor", overwrite = false } = options;

  // 1. Check .minsky/config.yaml exists — error if not
  const configPath = path.join(repoPath, ".minsky", "config.yaml");
  const configExists = await fileSystem.exists(configPath);
  if (!configExists) {
    throw new Error(
      `No .minsky/config.yaml found at ${configPath}. Run 'minsky init' first to initialize this project.`
    );
  }

  // 2. Read and parse config.yaml
  const configContent = await fileSystem.readFile(configPath, "utf-8");
  const projectConfig = yamlParse(configContent) as MinimalProjectConfig;

  // 3. Extract mcp section (default to { transport: "stdio" } if missing)
  const mcpConfig: MinimalMcpConfig = projectConfig?.mcp ?? { transport: "stdio" };
  const transport = mcpConfig.transport ?? "stdio";

  // 4. Register with the MCP client — writes the harness config file (e.g. .cursor/mcp.json)
  await registerWithClient(
    repoPath,
    { transport, port: mcpConfig.port, host: mcpConfig.host },
    client,
    fileSystem,
    overwrite
  );

  // Determine the harness config path for the result (for reporting)
  const registrar = getRegistrar(client);
  const harnessConfigPath = registrar.configPath(repoPath);

  // 5. Write .minsky/config.local.yaml with workspace.mainPath AND harness field
  const localConfigPath = path.join(repoPath, ".minsky", "config.local.yaml");
  const localConfigContent = yamlStringify({
    workspace: { mainPath: repoPath },
    harness: client,
  });
  await createFileIfNotExists(localConfigPath, localConfigContent, overwrite, fileSystem);

  // 6. Return result
  return {
    success: true,
    localConfigPath,
    harnessConfigPath,
    client,
    message: `Setup complete. Local config written to ${localConfigPath}. Harness config written to ${harnessConfigPath}.`,
  };
}
