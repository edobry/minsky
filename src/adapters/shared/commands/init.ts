import { z } from "zod";
import { existsSync } from "fs";
import * as path from "path";
import { select, isCancel, cancel, text, confirm } from "@clack/prompts";
import { getErrorMessage } from "@minsky/domain/errors/index";
import {
  sharedCommandRegistry,
  CommandCategory,
  defineCommand,
  type CommandParameterMap,
} from "../command-registry";
import {
  initializeProjectFromParams,
  detectRepositoryBackend,
  type DeclinableRule,
  type ResolvedRepositoryConfig,
} from "@minsky/domain/init";
import { enableRule, disableRule } from "@minsky/domain/rules/operations/config-operations";
import { TaskBackend } from "@minsky/domain/configuration/backend-detection";
import { resolveInitClient } from "@minsky/domain/runtime/harness-detection";
import { RULE_FORMAT_DESCRIPTION } from "../../../utils/option-descriptions";
import { log } from "@minsky/shared/logger";
import { ValidationError } from "@minsky/domain/errors/index";
import { CommonParameters, composeParams } from "../common-parameters";
import { isInteractive } from "../../../utils/interactive";
// Removed unused initParamsSchema import

const initParams = composeParams(
  {
    // Use shared parameters where possible
    repo: {
      schema: z.string().optional(),
      description: "Repository path to initialize",
      required: false,
    },
    session: CommonParameters.session,
    backend: CommonParameters.backend,
    overwrite: CommonParameters.overwrite,
    workspacePath: CommonParameters.workspace,
  },
  {
    // Init-specific parameters
    githubOwner: {
      schema: z.string().optional(),
      description: "GitHub repository owner (required for github-issues backend)",
      required: false,
    },
    githubRepo: {
      schema: z.string().optional(),
      description: "GitHub repository name (required for github-issues backend)",
      required: false,
    },
    ruleFormat: {
      schema: z.string().optional(),
      description: RULE_FORMAT_DESCRIPTION,
      required: false,
    },
    mcp: {
      schema: z.union([z.string(), z.boolean()]).optional(),
      description: "Enable/disable MCP configuration (default: true)",
      required: false,
    },
    mcpTransport: {
      schema: z.string().optional(),
      description: "MCP transport type (stdio, sse, httpStream)",
      required: false,
    },
    mcpPort: {
      schema: z.string().optional(),
      description: "Port for MCP network transports",
      required: false,
    },
    mcpHost: {
      schema: z.string().optional(),
      description: "Host for MCP network transports",
      required: false,
    },
    // mt#4872 SC4: the non-interactive half of the selection surface. The
    // conversation is the primary path and needs no flags; these exist so CI
    // and scripted onboarding are complete WITHOUT it.
    enable: {
      schema: z.union([z.string(), z.array(z.string())]).optional(),
      description:
        "Rule ids to enable, comma-separated (non-interactive selection; see `minsky rules list`)",
      required: false,
    },
    disable: {
      schema: z.union([z.string(), z.array(z.string())]).optional(),
      description:
        "Rule ids to decline, comma-separated (non-interactive selection; base rules cannot be declined)",
      required: false,
    },
  }
) satisfies CommandParameterMap;

/**
 * Split a repeatable/comma-separated id parameter into ids (mt#4872 SC4).
 *
 * Accepts both shapes because the CLI and MCP surfaces supply different ones:
 * `--disable a,b` arrives as one string, an MCP caller can pass an array.
 */
export function parseRuleIds(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .flatMap((entry) => entry.split(","))
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/**
 * Compose `init`'s operator-facing message, declinable set included (mt#4872 SC2).
 *
 * Extracted rather than inlined in `execute` so the CLI leg is assertable as a
 * VALUE. The alternative is driving the whole command to observe one string,
 * which is the shape `testing-standards.mdc §Testable Design` says to treat as
 * design feedback.
 *
 * Why the list rides in `message` rather than in a payload field alone: the
 * `minsky init` CLI command is hand-written (`src/commands/init/index.ts`,
 * registered top-level because the INIT category is hidden from CLI
 * auto-generation) and prints `result.message` and nothing else. A `declinable`
 * array would reach the MCP tool result and be dropped on stdout. Both surfaces
 * are fed from here, so they cannot drift.
 */
export function formatInitMessage(declinable: readonly DeclinableRule[]): string {
  const headline = "Project initialized successfully.";
  if (declinable.length === 0) return headline;
  return [
    headline,
    "",
    `${declinable.length} optional rule(s) were installed and can be turned off:`,
    ...declinable.map((rule) => `  - ${rule.id}: ${rule.description}`),
    "",
    "Decline any with `minsky rules disable <id>` then `minsky compile`.",
    "They stay until you remove them.",
  ].join("\n");
}

export function registerInitCommands() {
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "init",
      category: CommandCategory.INIT,
      name: "init",
      description: "Initialize a project for Minsky",
      parameters: initParams,
      requiresSetup: false,
      execute: async (params, _ctx) => {
        try {
          // Map CLI params to domain params
          const repoPath = params.repo || params.workspacePath || process.cwd();
          const overwrite = params.overwrite ?? false;

          // If config.yaml already exists and --overwrite is not set, inform the user
          // and return early — the project is already initialized.
          const configYamlPath = path.join(repoPath, ".minsky", "config.yaml");
          if (!overwrite && existsSync(configYamlPath)) {
            log.info(
              "Project already initialized. Run `minsky setup` for developer-local configuration."
            );
            return {
              success: true,
              message:
                "Project already initialized. Run `minsky setup` for developer-local configuration.",
            };
          }

          // Interactive backend selection if not provided
          let backend = params.backend;
          if (!backend) {
            // Check if we're in an interactive environment
            if (!isInteractive()) {
              // eslint-disable-next-line custom/no-validation-error-in-execute
              throw new ValidationError(
                `Backend parameter is required in non-interactive mode. Use --backend to specify: ${TaskBackend.MINSKY} or ${TaskBackend.GITHUB_ISSUES}`
              );
            }

            const selectedBackend = await select({
              message: "Select a task backend:",
              options: [
                { value: TaskBackend.MINSKY, label: "Minsky database (recommended)" },
                {
                  value: TaskBackend.GITHUB_ISSUES,
                  label: "GitHub Issues (for GitHub integration)",
                },
              ],
              initialValue: TaskBackend.MINSKY,
            });

            if (isCancel(selectedBackend)) {
              cancel("Initialization cancelled.");
              return { success: false, message: "Initialization cancelled by user." };
            }

            backend = selectedBackend as string;
          }

          // Interactive GitHub configuration if github-issues backend selected
          let githubOwner = params.githubOwner;
          let githubRepo = params.githubRepo;

          if (backend === TaskBackend.GITHUB_ISSUES) {
            if (!githubOwner) {
              if (!isInteractive()) {
                // eslint-disable-next-line custom/no-validation-error-in-execute
                throw new ValidationError(
                  "GitHub owner is required when using github-issues backend. Use --github-owner to specify."
                );
              }

              const ownerInput = await text({
                message: "Enter GitHub repository owner:",
                placeholder: "e.g., octocat",
                validate: (value) => {
                  if (!value || value.trim().length === 0) {
                    return "GitHub owner is required";
                  }
                  return undefined;
                },
              });

              if (isCancel(ownerInput)) {
                cancel("Initialization cancelled.");
                return { success: false, message: "Initialization cancelled by user." };
              }

              githubOwner = ownerInput.trim();
            }

            if (!githubRepo) {
              if (!isInteractive()) {
                // eslint-disable-next-line custom/no-validation-error-in-execute
                throw new ValidationError(
                  "GitHub repository name is required when using github-issues backend. Use --github-repo to specify."
                );
              }

              const repoInput = await text({
                message: "Enter GitHub repository name:",
                placeholder: "e.g., my-project",
                validate: (value) => {
                  if (!value || value.trim().length === 0) {
                    return "GitHub repository name is required";
                  }
                  return undefined;
                },
              });

              if (isCancel(repoInput)) {
                cancel("Initialization cancelled.");
                return { success: false, message: "Initialization cancelled by user." };
              }

              githubRepo = repoInput.trim();
            }
          }

          // Interactive rule format selection if not provided
          let ruleFormat = params.ruleFormat;
          if (!ruleFormat) {
            // mt#4715: the default derives from the harness actually running
            // init, not a fixed "cursor". Claude Code reads neither
            // `.cursor/rules` nor `.ai/rules`; it reads `CLAUDE.md` and
            // `.claude/rules`, which the compile pipeline emits FROM
            // `.minsky/rules` sources. So a Claude Code project scaffolds
            // sources in the canonical `minsky` location and
            // `initializeProject` compiles them for that harness.
            //
            // Shared by BOTH branches (PR #3431 R1): the non-interactive path
            // is where the wrong default actually bit, but leaving the prompt
            // hardcoded to "cursor" made the two paths disagree about what a
            // Claude Code project should get.
            const harnessDefaultRuleFormat =
              resolveInitClient() === "claude-code" ? "minsky" : "cursor";

            if (!isInteractive()) {
              ruleFormat = harnessDefaultRuleFormat;
            } else {
              const selectedFormat = await select({
                message: "Select rule format:",
                options: [
                  { value: "cursor", label: "Cursor (.cursor/rules; for the Cursor editor)" },
                  {
                    value: "minsky",
                    label: "Minsky (.minsky/rules sources; compiles to CLAUDE.md for Claude Code)",
                  },
                  { value: "generic", label: "Generic (.ai/rules; for other editors)" },
                ],
                initialValue: harnessDefaultRuleFormat,
              });

              if (isCancel(selectedFormat)) {
                cancel("Initialization cancelled.");
                return { success: false, message: "Initialization cancelled by user." };
              }

              ruleFormat = selectedFormat as string;
            }
          }

          // Interactive MCP configuration if not provided
          let mcp:
            | {
                enabled: boolean;
                transport: "stdio" | "sse" | "httpStream";
                port?: number;
                host?: string;
              }
            | undefined = undefined;

          if (params.mcp !== undefined || params.mcpTransport || params.mcpPort || params.mcpHost) {
            // Use provided MCP parameters
            mcp = {
              enabled:
                params.mcp === undefined ? true : params.mcp === true || params.mcp === "true",
              transport: (params.mcpTransport as "stdio" | "sse" | "httpStream") || "stdio",
              port: params.mcpPort ? Number(params.mcpPort) : undefined,
              host: params.mcpHost,
            };
          } else if (isInteractive()) {
            // Interactive MCP configuration
            const enableMcp = await confirm({
              message: "Enable MCP (Model Context Protocol) configuration?",
              initialValue: true,
            });

            if (isCancel(enableMcp)) {
              cancel("Initialization cancelled.");
              return { success: false, message: "Initialization cancelled by user." };
            }

            if (enableMcp) {
              const transport = await select({
                message: "Select MCP transport type:",
                options: [
                  { value: "stdio", label: "STDIO (recommended)" },
                  { value: "sse", label: "Server-Sent Events" },
                  { value: "httpStream", label: "HTTP Stream" },
                ],
                initialValue: "stdio",
              });

              if (isCancel(transport)) {
                cancel("Initialization cancelled.");
                return { success: false, message: "Initialization cancelled by user." };
              }

              mcp = {
                enabled: true,
                transport: transport as "stdio" | "sse" | "httpStream",
              };

              // Ask for port and host if not stdio
              if (transport !== "stdio") {
                const portInput = await text({
                  message: "Enter port number (optional):",
                  placeholder: "e.g., 3000",
                  validate: (value) => {
                    if (value && isNaN(Number(value))) {
                      return "Port must be a number";
                    }
                    return undefined;
                  },
                });

                if (isCancel(portInput)) {
                  cancel("Initialization cancelled.");
                  return { success: false, message: "Initialization cancelled by user." };
                }

                const hostInput = await text({
                  message: "Enter host (optional):",
                  placeholder: "e.g., localhost",
                });

                if (isCancel(hostInput)) {
                  cancel("Initialization cancelled.");
                  return { success: false, message: "Initialization cancelled by user." };
                }

                if (portInput) mcp.port = Number(portInput);
                if (hostInput) mcp.host = hostInput;
              }
            }
          }

          // Detect repository backend from git remote
          let repository: ResolvedRepositoryConfig | undefined;
          const detectedRepo = detectRepositoryBackend(repoPath);

          if (detectedRepo.backend !== "local") {
            if (isInteractive()) {
              // Interactive mode: show detection and ask for confirmation
              const detectionLabel =
                detectedRepo.backend === "github" && detectedRepo.github
                  ? `GitHub repository (${detectedRepo.github.owner}/${detectedRepo.github.repo})`
                  : `${detectedRepo.backend} repository (${detectedRepo.url ?? ""})`;

              const useDetected = await confirm({
                message: `Detected ${detectionLabel}. Use ${detectedRepo.backend === "github" ? "GitHub" : detectedRepo.backend} for PRs?`,
                initialValue: true,
              });

              if (isCancel(useDetected)) {
                cancel("Initialization cancelled.");
                return { success: false, message: "Initialization cancelled by user." };
              }

              if (useDetected) {
                repository = detectedRepo;
              } else {
                repository = { backend: "local" };
              }
            } else {
              // Non-interactive mode: auto-accept detection
              repository = detectedRepo;
            }
          } else {
            repository = { backend: "local" };
          }

          // Use the backend selected by the user (or provided via CLI parameter)
          const domainBackend = backend;

          // mt#4872 SC4: apply the non-interactive selection BEFORE init runs.
          // Order is load-bearing — init reads the committed selection to decide
          // what to scaffold and then compiles from it, so applying the flags
          // first means one pass produces the right rules AND the right compiled
          // output. Applying them afterwards would need a second compile, and
          // would leave the intermediate state emitting rules the caller had
          // just declined. `enableRule` / `disableRule` are the same functions
          // `minsky rules enable|disable` calls, so the flags and the
          // conversation write identical config (AT4); they also validate the
          // id, so a typo fails here rather than persisting into the config.
          for (const ruleId of parseRuleIds(params.enable as string | string[] | undefined)) {
            await enableRule(repoPath, ruleId);
          }
          for (const ruleId of parseRuleIds(params.disable as string | string[] | undefined)) {
            await disableRule(repoPath, ruleId);
          }

          const initResult = await initializeProjectFromParams({
            repoPath,
            backend: domainBackend,
            ruleFormat: ruleFormat as "cursor" | "generic" | "minsky",
            mcp,
            overwrite,
            repository,
          });

          // TODO: Handle GitHub-specific configuration when github-issues backend is selected
          // This would involve setting up GitHub API configuration, but that's not implemented yet
          // For now, we proceed with the basic initialization
          if (backend === TaskBackend.GITHUB_ISSUES) {
            log.debug("GitHub Issues backend selected", { githubOwner, githubRepo });
            // Future: Set up GitHub API configuration, webhooks, etc.
          }

          // mt#4872 SC2 — the declinable set reaches all three invocation paths.
          //
          // The structured `declinable` field is what an agent on the
          // `mcp__minsky__init` path reads: stdout never reaches it, so the
          // scaffold's printed lines are invisible there.
          //
          // The `message` carries the same list because of how the CLI renders.
          // `init` registers no `outputFormatter` and is not switch-cased in
          // `formatObjectResult`, so it falls through to `formatGenericObject`,
          // whose `if (result.message) { … return; }` branch fires BEFORE the
          // branch that renders payload keys (the one ADR-039 added). A
          // `declinable` field alone would therefore reach the MCP result and be
          // silently dropped on both stdout paths. Folding it into `message` is
          // the resolution ADR-039 sanctions that needs no per-command
          // formatter — and it is why AT2 measures all three paths rather than
          // assuming the payload is enough.
          const declinable = initResult.declinable;

          return {
            success: true,
            message: formatInitMessage(declinable),
            declinable,
            withheld: initResult.withheld,
          };
        } catch (error: unknown) {
          log.error("Error initializing project", { error });
          throw error instanceof ValidationError
            ? error
            : new ValidationError(getErrorMessage(error));
        }
      },
    })
  );
}
