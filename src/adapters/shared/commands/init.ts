import { z } from "zod";
import { getErrorMessage } from "../../../errors/index";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandExecutionContext,
  type CommandParameterMap,
} from "../command-registry.js";
import { initializeProjectFromParams } from "../../../domain/init.js";
import { log } from "../../../utils/logger.js";
import { ValidationError } from "../../../errors/index.js";
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
    schema: z.enum(["markdown", "json-file", "github-issues"]).optional(),
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
    execute: async (params, _ctx: CommandExecutionContext) => {
      try {
        // Map CLI params to domain params
        const repoPath = params.repo || params.workspacePath || process.cwd();
        const backend = params.backend === "tasks.csv" ? "tasks.csv" : "tasks.md";
        const ruleFormat = params.ruleFormat === "generic" ? "generic" : "cursor";
        const mcpOnly = params.mcpOnly ?? false;
        const overwrite = params.overwrite ?? false;
        // Map MCP options
        let mcp:
          | {
              enabled: boolean;
              transport: "stdio" | "sse" | "httpStream";
              port?: number;
              host?: string;
            }
          | undefined = undefined;
        if (params.mcp !== undefined || params.mcpTransport || params.mcpPort || params.mcpHost) {
          mcp = {
            enabled: params.mcp === undefined ? true : params.mcp === true || params.mcp === "true",
            transport: params.mcpTransport || "stdio",
            port: params.mcpPort ? Number(params.mcpPort) : undefined as any,
            host: params.mcpHost,
          };
        }
        await initializeProjectFromParams({
          repoPath,
          backend,
          ruleFormat,
          mcp,
          mcpOnly,
          overwrite,
        });
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
