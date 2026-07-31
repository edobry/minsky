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
import {
  resolveExistingPostgresConnection,
  type ResolveExistingConnectionDeps,
  type ResolveExistingConnectionResult,
} from "./setup-db";
import { provisionProjectRow, type ProvisionProjectRowDeps } from "./project/provision";
import { log } from "@minsky/shared/logger";

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
  /**
   * Postgres connection-inheritance status, resolved via the config loader
   * (mt#2502): whether an already-configured connection was found (project/user
   * config or env), where it came from, and whether it is currently reachable.
   * CLI callers use this to decide whether to fall back to the interactive
   * `setup db` wizard.
   */
  dbConnection: ResolveExistingConnectionResult;
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
 * 5. Write .minsky/config.local.yaml with workspace.mainPath and workspace.harness
 * 6. Resolve an already-configured Postgres connection via the config loader
 *    (mt#2502) — reports source + connectivity so a second project on the
 *    unified instance can inherit it instead of re-prompting. This step is a
 *    pure resolve-and-verify — it never writes config or prompts; the CLI
 *    caller decides whether to fall back to the interactive `setup db` wizard
 *    when nothing resolves or the resolved connection isn't reachable.
 * 6b. If that connection is found AND verified live, ensure this project's
 *    `projects` row exists (mt#2934) — one of the two confirmed-connection
 *    provisioning points decided in the mt#2934 spec (the other is the
 *    `setup db` wizard's fresh-connection success path, `setup-db.ts`). A
 *    failed or skipped provisioning attempt does not fail `setup` overall.
 * 7. Return result describing what was written
 */
export async function performSetup(
  options: SetupOptions,
  fileSystem: FsLike = createRealFs(),
  dbDeps: ResolveExistingConnectionDeps = {},
  provisionDeps: ProvisionProjectRowDeps = {}
): Promise<SetupResult> {
  const { repoPath, client = "cursor", overwrite = true } = options;

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

  // 5. Write .minsky/config.local.yaml with workspace.mainPath and workspace.harness
  // Both fields belong under the `workspace` key — placing `harness` at the root
  // would be rejected by the strict config-schema validator (mt#1939).
  const localConfigPath = path.join(repoPath, ".minsky", "config.local.yaml");
  const localConfigContent = yamlStringify({
    workspace: { mainPath: repoPath, harness: client },
  });
  await createFileIfNotExists(localConfigPath, localConfigContent, overwrite, fileSystem);

  // 6. Resolve an already-configured Postgres connection (pure resolve + verify; no writes).
  const dbConnection = await resolveExistingPostgresConnection(dbDeps);

  // 6b. Confirmed-connection provisioning point (mt#2934): if a connection was
  // found AND verified live, ensure this project's `projects` row exists.
  // `resolveProjectScope`'s fail-open ALL_PROJECTS default otherwise never
  // gets a row to resolve for a brand-new project's slug. Defense-in-depth:
  // provisionProjectRow already swallows its own failures, but a failed
  // attempt must not fail `setup` overall even if a dep override throws.
  if (dbConnection.found && dbConnection.connectivity?.ok && dbConnection.connectionString) {
    try {
      await provisionProjectRow(dbConnection.connectionString, { repoPath }, provisionDeps);
    } catch (err) {
      log.warn("[setup] project-row provisioning failed; setup still succeeded", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 7. Return result
  return {
    success: true,
    localConfigPath,
    harnessConfigPath,
    client,
    message: `Setup complete. Local config written to ${localConfigPath}. Harness config written to ${harnessConfigPath}.`,
    dbConnection,
  };
}
