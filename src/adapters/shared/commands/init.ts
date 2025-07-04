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
    schema: z.enum(["markdown", "json-file", "github-issues"] as any[]).optional(),
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
    schema: (z.union([z.string(), z.boolean()]) as any).optional(),
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
    schema: (z.boolean() as any).optional(),
    description: "Only configure MCP, skip other initialization steps",
    required: false,
  },
  overwrite: {
    schema: (z.boolean() as any).optional(),
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
  (sharedCommandRegistry as any).registerCommand({
    id: "init",
    category: (CommandCategory as any).INIT,
    name: "init",
    description: "Initialize a project for Minsky",
    parameters: initParams,
    execute: async (params, _ctx: CommandExecutionContext) => {
      try {
        // Map CLI params to domain params
        const repoPath = (params as any).repo || (params as any).workspacePath || (process as any).cwd();
        const backend = (params as any).backend === "tasks.csv" ? "tasks.csv" : "tasks.md";
        const ruleFormat = (params as any).ruleFormat === "generic" ? "generic" : "cursor";
        const mcpOnly = (params as any).mcpOnly ?? false;
        const overwrite = (params as any).overwrite ?? false;
        // Map MCP options
        let mcp:
          | {
              enabled: boolean;
              transport: "stdio" | "sse" | "httpStream";
              port?: number;
              host?: string;
            }
          | undefined = undefined;
        if ((params as any).mcp !== undefined || (params as any).mcpTransport || (params as any).mcpPort || (params as any).mcpHost) {
          mcp = {
            enabled: (params as any).mcp === undefined ? true : (params as any).mcp === true || (params as any).mcp === "true",
            transport: (params as any).mcpTransport || "stdio",
            port: (params as any).mcpPort ? Number((params as any).mcpPort) : undefined as any,
            host: (params as any).mcpHost,
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
          : new ValidationError(getErrorMessage(error as any));
      }
    },
  });
}
