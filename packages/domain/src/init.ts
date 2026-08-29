import * as path from "path";
import { z } from "zod";
import { enumSchemas } from "./configuration/schemas/base";
import { createDirectoryIfNotExists, createFileIfNotExists } from "./init/file-system";
import type { FsLike } from "./interfaces/fs-like";
import { createRealFs } from "./interfaces/real-fs";
import { getMinskyConfigContentYaml } from "./init/config-content";
import { generateRulesWithTemplateSystem } from "./init/rule-templates";
import { RULE_FORMAT_OUTPUT_DIR } from "./rules/types";
import { runMinskyCompile } from "./compile/compile";
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
/**
 * Injectable collaborators for {@link initializeProject} (mt#4715).
 *
 * `compileForHarness` exists as a SEAM rather than a direct `runMinskyCompile`
 * call because that function resolves and writes through the REAL filesystem,
 * while `initializeProject` is otherwise driven by an injected {@link FsLike}.
 * Calling it unguarded would make a unit test with a mock filesystem reach the
 * actual repo — so the collaborator is handed in instead of reached for, per
 * `testing-standards.mdc §Testable Design`.
 */
export interface InitializeProjectDeps {
  /** Compile one target into `workspacePath`. Defaults to the real pipeline. */
  compileForHarness?: (target: string, workspacePath: string) => Promise<void>;
  /** Which MCP client / harness is running init. Defaults to real detection. */
  resolveClient?: () => string;
}

export async function initializeProject(
  { repoPath, backend, ruleFormat, mcp, overwrite = false, repository }: InitializeProjectOptions,
  fileSystem: FsLike = createRealFs(),
  deps: InitializeProjectDeps = {}
): Promise<void> {
  const resolveClient = deps.resolveClient ?? resolveInitClient;
  const compileForHarness =
    deps.compileForHarness ??
    (async (target: string, workspacePath: string) => {
      await runMinskyCompile({ target, workspacePath });
    });
  // Resolved ONCE and reused: the rule-scaffolding step below and performSetup
  // must agree about which harness is running, or a project could be scaffolded
  // for one client and registered with another.
  const initClient = resolveClient();
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

  // mt#4715: scaffolding SOURCES is only half the job. `ruleFormat` picks a
  // directory, and Claude Code reads NONE of the three it can pick — it reads
  // `CLAUDE.md` and `.claude/rules`, which the compile pipeline produces FROM
  // `.minsky/rules/*.mdc` sources. Those are exactly what the step above just
  // wrote (`getRulePath` emits `<id>.mdc`, bodies carry YAML frontmatter), so
  // this is a wiring step, not a format conversion. Without it a Claude Code
  // project is scaffolded with files its own harness never opens.
  //
  // Only the two channels Claude Code actually implements are compiled
  // (mt#3107): `claude.md` for the always-apply corpus and `claude-rules` for
  // path-scoped `.claude/rules/<id>.md`. Cursor's other two rule types have no
  // delivery mechanism here, so emitting more targets would write files nothing
  // reads — the very defect this step removes.
  if (initClient === "claude-code") {
    for (const target of ["claude.md", "claude-rules"]) {
      try {
        await compileForHarness(target, repoPath);
      } catch (error) {
        // SURFACED, not swallowed (mt#4715 SC5). `init` must still succeed —
        // a project with sources but no compiled output is recoverable by
        // running `minsky compile` — but a silently un-scaffolded project is
        // the defect, not the mitigation (`work-completion.mdc §Invocation
        // path`), so the failure has to reach someone.
        log.warn(
          `minsky init: could not compile "${target}" for claude-code. The rule sources in ` +
            `.minsky/rules were written; run \`minsky compile\` to produce CLAUDE.md and ` +
            `.claude/rules. Cause: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
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
      // `initClient`, not a second resolveInitClient() call (mt#4715): rule
      // scaffolding above already branched on it, and two independent
      // resolutions could disagree.
      { repoPath, client: initClient, overwrite, mcp: mcpForConfig },
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
