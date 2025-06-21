import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { 
  CallToolRequestSchema, 
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
  ListToolsResult,
  CallToolResult,
  CallToolRequest,
  Tool
} from "@modelcontextprotocol/sdk/types.js";
import { log } from "../utils/logger";
import type { ProjectContext } from "../types/project";
import { createProjectContextFromCwd } from "../types/project";

/**
 * Configuration options for the Minsky MCP server
 */
export interface MinskyMCPServerOptions {
  /**
   * The name of the server
   * @default "Minsky MCP Server"
   */
  name?: string;

  /**
   * The version of the server
   * @default "current version of Minsky"
   */
  version?: string;

  /**
   * Transport type to use for the server
   * @default "stdio"
   */
  transportType?: "stdio" | "sse";

  /**
   * Project context containing repository information
   * Used for operations that require repository context
   */
  projectContext?: ProjectContext;

  /**
   * Configuration for SSE transport
   */
  sse?: {
    /**
     * Port to listen on
     * @default 3000
     */
    port?: number;

    /**
     * Host to bind to
     * @default "localhost"
     */
    host?: string;

    /**
     * Path for SSE endpoint
     * @default "/sse"
     */
    path?: string;
  };
}

/**
 * Minsky MCP Server implementation using the official MCP SDK
 */
export class MinskyMCPServer {
  private server: Server;
  private options: Required<MinskyMCPServerOptions>;
  private projectContext: ProjectContext;

  constructor(_options: MinskyMCPServerOptions = {}) {
    this.options = {
      name: options.name ?? "Minsky MCP Server",
      version: options.version ?? "1.0.0",
      transportType: options.transportType ?? "stdio",
      projectContext: options.projectContext ?? createProjectContextFromCwd(),
      sse: {
        port: options.sse?.port ?? 3000,
        host: options.sse?.host ?? "localhost",
        path: options.sse?.path ?? "/sse",
      },
    };

    this.projectContext = this.options.projectContext;

    // Create the MCP server
    this.server = new Server(
      {
        name: this.options.name,
        version: this.options.version,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // Handle tool listing
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: Tool[] = [
        {
          name: "git.status",
          description: "Get the current git status of the repository",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "git.log", 
          description: "Get git commit history",
          inputSchema: {
            type: "object",
            properties: {
              maxCount: {
                type: "number",
                description: "Maximum number of commits to return",
                default: 10,
              },
            },
          },
        },
        {
          name: "tasks.list",
          description: "List all tasks in the project",
          inputSchema: {
            type: "object", 
            properties: {},
          },
        },
        {
          name: "tasks.create",
          description: "Create a new task",
          inputSchema: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: "Task title",
              },
              description: {
                type: "string", 
                description: "Task description",
              },
            },
            required: ["title"],
          },
        },
        {
          name: "tasks.update",
          description: "Update an existing task",
          inputSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "Task ID",
              },
              title: {
                type: "string",
                description: "New task title",
              },
              description: {
                type: "string",
                description: "New task description", 
              },
            },
            required: ["id"],
          },
        },
        {
          name: "session.create",
          description: "Create a new session for a task",
          inputSchema: {
            type: "object",
            properties: {
              taskId: {
                type: "string", 
                description: "Task ID to create session for",
              },
            },
            required: ["taskId"],
          },
        },
        {
          name: "session.list",
          description: "List all sessions",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "project.info",
          description: "Get project information",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
      ];

      const result: ListToolsResult = {
        tools,
      };

      return result;
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (_request: unknown) => {
      const { name, arguments: args } = request.params;

      try {
        let result: any;

        switch (name) {
          case "git.status":
            result = await this.handleGitStatus();
            break;
          case "git.log":
            result = await this.handleGitLog(args?.maxCount as number | undefined);
            break;
          case "tasks.list":
            result = await this.handleTasksList();
            break;
          case "tasks.create":
            result = await this.handleTasksCreate(args?.title as string, args?.description as string | undefined);
            break;
          case "tasks.update":
            result = await this.handleTasksUpdate(args?.id as string, args?.title as string | undefined, args?.description as string | undefined);
            break;
          case "session.create":
            result = await this.handleSessionCreate(args?.taskId as string);
            break;
          case "session.list":
            result = await this.handleSessionList();
            break;
          case "project.info":
            result = await this.handleProjectInfo();
            break;
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${name}`
            );
        }

        const callResult: CallToolResult = {
          content: [
            {
              type: "text",
              text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
            },
          ],
        };

        return callResult;
      } catch {
        log.error(`Error executing tool ${name}:`, {
          error: error instanceof Error ? error.message : String(error),
        });
        throw new McpError(
          ErrorCode.InternalError,
          `Error executing tool: ${error instanceof Error ? error.message : "Unknown error"}`
        );
      }
    });
  }

  private async handleGitStatus(): Promise<string> {
    return `Git status for repository: ${this.projectContext.repositoryPath}`;
  }

  private async handleGitLog(maxCount: number = 10): Promise<string> {
    return `Git log (last ${maxCount} commits) for repository: ${this.projectContext.repositoryPath}`;
  }

  private async handleTasksList(): Promise<string> {
    return "Tasks list - placeholder implementation";
  }

  private async handleTasksCreate(title: string, description?: string): Promise<string> {
    return `Created task: ${title}${description ? ` - ${description}` : ""}`;
  }

  private async handleTasksUpdate(_id: string, title?: string, description?: string): Promise<string> {
    return `Updated task ${id}${title ? ` with title: ${title}` : ""}${description ? ` and description: ${description}` : ""}`;
  }

  private async handleSessionCreate(taskId: string): Promise<string> {
    return `Created session for task: ${taskId}`;
  }

  private async handleSessionList(): Promise<string> {
    return "Session list - placeholder implementation";
  }

  private async handleProjectInfo(): Promise<string> {
    return `Project: ${this.projectContext.repositoryPath}`;
  }

  /**
   * Start the MCP server with the configured transport
   */
  async start(): Promise<void> {
    log.agent(`Starting Minsky MCP Server (${this.options.name}) with ${this.options.transportType} transport`);

    if (this.options.transportType === "stdio") {
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      log.agent("MCP Server started with stdio transport");
    } else if (this.options.transportType === "sse") {
      const transport = new SSEServerTransport(
        this.options.sse.path ?? "/sse",
        {
          port: this.options.sse.port,
          host: this.options.sse.host,
        }
      );
      await this.server.connect(transport);
      log.agent(`MCP Server started with SSE transport on ${this.options.sse.host ?? "localhost"}:${this.options.sse.port}${this.options.sse.path ?? "/sse"}`);
    } else {
      throw new Error(`Unsupported transport type: ${this.options.transportType}`);
    }
  }

  /**
   * Stop the MCP server
   */
  async stop(): Promise<void> {
    await this.server.close();
    log.agent("MCP Server stopped");
  }

  /**
   * Get the underlying MCP server instance
   */
  getServer(): Server {
    return this.server;
  }
}
