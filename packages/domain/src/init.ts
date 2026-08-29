import * as path from "path";
import { z } from "zod";
import { enumSchemas } from "./configuration/schemas/base";
import { createDirectoryIfNotExists, createFileIfNotExists } from "./init/file-system";
import type { FsLike } from "./interfaces/fs-like";
import { createRealFs } from "./interfaces/real-fs";
import { getMinskyConfigContentYaml } from "./init/config-content";
import { generateRulesWithTemplateSystem } from "./init/rule-templates";
import { RULE_FORMAT_OUTPUT_DIR } from "./rules/types";
import {
  resolveRepositoryFromGitRemote,
  type ResolvedRepositoryConfig,
} from "./session/repository-backend-detection";
import { performSetup } from "./setup";
import { provisionObservabilityHooks } from "./setup/hook-provisioning";
import { resolveInitClient } from "./runtime/harness-detection";
import { log } from "./utils/logger";

export type { ResolvedRepositoryConfig } from "./session/repository-backend-detection";

/**
 * Detects the repository backend configuration from the git remote URL at the given path.
 * Convenience wrapper around resolveRepositoryFromGitRemote for use in init commands.
 */
export function detectRepositoryBackend(repoPath: string): ResolvedRepositoryConfig {
  return resolveRepositoryFromGitRemote(repoPath);
}

// Re-export content helpers for consumers that may reference them
export { getMinskyConfigContentYaml } from "./init/config-content";
export {
  getMinskyRuleContent,
  getRulesIndexContent,
  generateRulesWithTemplateSystem,
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
 * Orchestrates project initialization in two phases:
 *
 * Phase 1 (project-init): Creates project-level files checked into the repo —
 *   .minsky/config.yaml (with mcp section), process/tasks/ dir, rules directory,
 *   rule files. No harness-specific files.
 *
 * Phase 2 (developer-setup): Calls performSetup() to handle developer-local
 *   configuration — MCP client registration (.cursor/mcp.json) and
 *   .minsky/config.local.yaml with workspace.mainPath and harness field.
 *   Skipped when mcp.enabled is false.
 */
export async function initializeProject(
  { repoPath, backend, ruleFormat, mcp, overwrite = false, repository }: InitializeProjectOptions,
  fileSystem: FsLike = createRealFs()
): Promise<void> {
  // === Phase 1: Project initialization ===

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

  // Create rule file directory.
  //
  // mt#4714: the format→directory mapping is `RULE_FORMAT_OUTPUT_DIR` — the SAME
  // constant `RuleTemplateService.getOutputDir` uses, so init can no longer
  // disagree with it. This was a two-way ternary (`=== "cursor" ? .cursor/rules
  // : .ai/rules`), which sent `ruleFormat: "minsky"` to `.ai/rules` — the
  // `generic` location — while every other consumer resolved it to
  // `.minsky/rules`.
  //
  // The resolved path is still passed to `generateRulesWithTemplateSystem` as an
  // explicit `outputDir` rather than letting the service resolve it. That is
  // deliberate and NOT the override the bug was about: the mapping is now shared,
  // so the explicit value cannot diverge. Dropping the argument entirely would
  // also require reshaping that function, which derives the service's
  // `workspacePath` from this very path (`path.dirname` twice) — mt#4715 reworks
  // this call path and is the right place for it.
  const rulesDirPath = path.join(repoPath, ...RULE_FORMAT_OUTPUT_DIR[ruleFormat].split("/"));
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
  // Pass repoPath so getMinskyConfigContentYaml can auto-derive the project slug
  // from the git remote (mt#2414). Falls back gracefully when no remote exists.
  // `mcpForConfig` is NOT passed here any more (mt#4699) — it now goes to
  // performSetup below, which writes it to the machine-local overlay instead of
  // the committed config.
  const configContent = getMinskyConfigContentYaml(backend, repository, {
    repoPath,
  });
  await createFileIfNotExists(configPath, configContent, overwrite, fileSystem);

  // === Phase 2: Developer-local setup ===
  // Skipped when MCP is explicitly disabled (e.g. in tests or non-MCP workflows).
  // performSetup() writes .minsky/config.local.yaml (with harness field) and
  // registers Minsky with the MCP client (e.g. .cursor/mcp.json).
  if (mcp?.enabled !== false) {
    // mt#4676: resolve the harness from the environment (CLAUDECODE=1, etc.)
    // before falling back to filesystem installed-ness, rather than
    // hardcoding "cursor" regardless of what is actually running `init`.
    // mt#4699: hand the MCP options straight to performSetup rather than
    // routing them through the committed config.yaml it used to read them
    // back out of. They land in `.minsky/config.local.yaml`, which is where
    // machine-scope settings belong.
    await performSetup(
      { repoPath, client: resolveInitClient(), overwrite, mcp: mcpForConfig },
      fileSystem
    );

    // Install the observability baseline so this project's conversations are
    // visible to cockpit attach + presence (mt#3499). Automatic, per ask#6671.
    // Developer-local like the rest of Phase 2: the hooks register in
    // `.claude/settings.local.json` and install into a Minsky-owned state
    // directory, so nothing lands in the project's committed tree.
    //
    // Non-fatal: a project that is otherwise correctly initialized must not
    // fail `init` because instrumentation could not be installed. The failure
    // is surfaced, not swallowed — a silently un-instrumented project is the
    // exact bug this provisioning exists to fix, so it must never look like
    // success.
    try {
      await provisionObservabilityHooks({ repoPath }, fileSystem);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.warn(
        `Minsky observability hooks were NOT installed: ${reason}\n` +
          `The project is initialized, but its conversations will not appear in the cockpit ` +
          `(attach and presence will read UNKNOWN). Re-run 'minsky init' after resolving the above.`
      );
    }
  }
}
