import { z } from "zod";
import { select, isCancel, cancel, text, confirm } from "@clack/prompts";
import { getErrorMessage } from "../../../errors/index";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandExecutionContext,
  type CommandParameterMap,
} from "../command-registry";
import { initializeProjectFromParams } from "../../../domain/init";
import { log } from "../../../utils/logger";
import { ValidationError } from "../../../errors/index";
// Removed unused initParamsSchema import

const initParams: CommandParameterMap = {
  repo: {
    schema: z.string().optional(),
    description: "Repository path to initialize",
    required: false,
  },
  session: {
    schema: z.string().optional(),
    description: "Session identifier",
    required: false,
  },
  backend: {
    schema: z.string().optional(),
    description: "Task backend type (markdown, json-file, github-issues)",
    required: false,
  },
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
    description: "Rule format (cursor or generic)",
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
  mcpOnly: {
    schema: z.boolean().optional(),
    description: "Only configure MCP, skip other initialization steps",
    required: false,
  },
  overwrite: {
    schema: z.boolean().optional(),
    description: "Overwrite existing files",
    required: false,
  },
  workspacePath: {
    schema: z.string().optional(),
    description: "Workspace path",
    required: false,
  },
};

export function registerInitCommands() {
  sharedCommandRegistry.registerCommand({
    id: "init",
    category: CommandCategory.INIT,
    name: "init",
    description: "Initialize a project for Minsky",
    parameters: initParams,
    execute: async (params: any, _ctx: CommandExecutionContext) => {
      try {
        // Map CLI params to domain params
        const repoPath = params.repo || params.workspacePath || process.cwd();
        
        // Interactive backend selection if not provided
        let backend = params.backend;
        if (!backend) {
          // Check if we're in an interactive environment
          if (!process.stdout.isTTY) {
            throw new ValidationError("Backend parameter is required in non-interactive mode. Use --backend to specify: markdown, json-file, or github-issues");
          }

          const selectedBackend = await select({
            message: "Select a task backend:",
            options: [
              { value: "json-file", label: "JSON File (recommended for new projects)" },
              { value: "markdown", label: "Markdown (for existing tasks.md workflows)" },
              { value: "github-issues", label: "GitHub Issues (for GitHub integration)" },
            ],
            initialValue: "json-file",
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
        
        if (backend === "github-issues") {
          if (!githubOwner) {
            if (!process.stdout.isTTY) {
              throw new ValidationError("GitHub owner is required when using github-issues backend. Use --github-owner to specify.");
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
            if (!process.stdout.isTTY) {
              throw new ValidationError("GitHub repository name is required when using github-issues backend. Use --github-repo to specify.");
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
          if (!process.stdout.isTTY) {
            // Default to cursor in non-interactive mode
            ruleFormat = "cursor";
          } else {
            const selectedFormat = await select({
              message: "Select rule format:",
              options: [
                { value: "cursor", label: "Cursor (default, optimized for Cursor editor)" },
                { value: "generic", label: "Generic (for other editors)" },
              ],
              initialValue: "cursor",
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
            enabled: params.mcp === undefined ? true : params.mcp === true || params.mcp === "true",
            transport: (params.mcpTransport as "stdio" | "sse" | "httpStream") || "stdio",
            port: params.mcpPort ? Number(params.mcpPort) : undefined,
            host: params.mcpHost,
          };
        } else if (process.stdout.isTTY && !params.mcpOnly) {
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

        const mcpOnly = params.mcpOnly ?? false;
        const overwrite = params.overwrite ?? false;

        // Map backend values to what the domain function expects
        const domainBackend = backend === "markdown" ? "tasks.md" : 
          backend === "json-file" ? "tasks.md" : // json-file also uses tasks.md for now
            backend === "github-issues" ? "tasks.md" : // github-issues uses tasks.md base
              "tasks.md"; // default fallback

        await initializeProjectFromParams({
          repoPath,
          backend: domainBackend,
          ruleFormat,
          mcp,
          mcpOnly,
          overwrite,
        });

        // TODO: Handle GitHub-specific configuration when github-issues backend is selected
        // This would involve setting up GitHub API configuration, but that's not implemented yet
        // For now, we proceed with the basic initialization
        if (backend === "github-issues") {
          log.debug("GitHub Issues backend selected", { githubOwner, githubRepo });
          // Future: Set up GitHub API configuration, webhooks, etc.
        }

        return { success: true, message: "Project initialized successfully." };
      } catch (error: any) {
        log.error("Error initializing project", { error });
        throw error instanceof ValidationError
          ? error
          : new ValidationError(getErrorMessage(error));
      }
    },
  });
}
