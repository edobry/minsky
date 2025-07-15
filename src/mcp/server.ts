import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { 
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { log } from "../utils/logger";
import type { ProjectContext } from "../types/project";
import { createProjectContextFromCwd } from "../types/project";
import { getErrorMessage } from "../errors/index";

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
   * @default "1.0.0"
   */
  version?: string;

  /**
   * Project context containing repository information
   * Used for operations that require repository context
   * @default Context created from process.cwd()
   */
  projectContext?: ProjectContext;
}

/**
 * Tool definition interface for registering tools with the MCP server
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: any; // JSON Schema
  handler: (args: any) => Promise<string | Record<string, any>>;
}

/**
 * Resource definition interface for registering resources with the MCP server
 */
export interface ResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  handler: () => Promise<{ text?: string; blob?: string }>;
}

/**
 * Prompt definition interface for registering prompts with the MCP server
 */
export interface PromptDefinition {
  name: string;
  description: string;
  arguments?: Array<{
    name: string;
    description: string;
    required?: boolean;
  }>;
  handler: (args: Record<string, string>) => Promise<{
    messages: Array<{
      role: "user" | "assistant";
      content: {
        type: "text";
        text: string;
      };
    }>;
  }>;
}

/**
 * MinskyMCPServer is the main class for the Minsky MCP server
 * It handles the MCP protocol communication and tool registration using the official SDK
 */
export class MinskyMCPServer {
  private server: Server;
  private transport: StdioServerTransport;
  private options: MinskyMCPServerOptions;
  private projectContext: ProjectContext;
  private tools: Map<string, ToolDefinition> = new Map();
  private resources: Map<string, ResourceDefinition> = new Map();
  private prompts: Map<string, PromptDefinition> = new Map();

  /**
   * Create a new MinskyMCPServer
   * @param options Configuration options for the server
   */
  constructor(options: MinskyMCPServerOptions = {}) {
    // Store the project context or create a default one
    try {
      this.projectContext = options.projectContext || createProjectContextFromCwd();
      log.debug("Using project context", {
        repositoryPath: this.projectContext.repositoryPath,
      });
    } catch (error) {
      log.warn(
        "Failed to create project context from current directory, tools requiring repository context may not work",
        {
          error: getErrorMessage(error as any),
        }
      );
      // Create a minimal context with an empty path, tools will need to handle this
      this.projectContext = { repositoryPath: "" };
    }

    this.options = {
      name: options.name || "Minsky MCP Server",
      version: options.version || "1.0.0",
      projectContext: this.projectContext,
    };

    // Create the official MCP server
    this.server = new Server(
      {
        name: this.options.name!,
        version: this.options.version!,
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
          logging: {},
        },
        instructions:
          "This server provides access to Minsky, a tool for managing AI-assisted development workflows.\n" +
          "You can use these tools to:\n" +
          "- Manage tasks and track their status\n" +
          "- Create and manage development sessions\n" +
          "- Perform git operations like commit, push, and PR creation\n" +
          "- Initialize new projects with Minsky\n" +
          "- Access and apply project rules\n\n" +
          "All tools return structured JSON responses for easy processing.",
      }
    );

    // Create stdio transport
    this.transport = new StdioServerTransport();

    // Set up request handlers
    this.setupRequestHandlers();

    // Set up event handlers
    this.setupEventHandlers();

    // Add default help resource
    this.addResource({
      uri: "minsky://help",
      name: "Minsky Help",
      description: "Basic help information for using Minsky MCP server",
      mimeType: "text/plain",
      handler: async () => ({
        text: `Minsky MCP Server Help

Available tools:
- Use 'tasks.*' commands to manage tasks
- Use 'session.*' commands to manage development sessions
- Use 'git.*' commands for git operations
- Use 'init.*' commands to initialize projects
- Use 'rules.*' commands to work with project rules

For more information, visit: https://github.com/your-org/minsky
`,
      }),
    });

    // Add default help prompt
    this.addPrompt({
      name: "minsky_help",
      description: "Get help with using Minsky MCP server",
      arguments: [],
      handler: async () => ({
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: "How can I use the Minsky MCP server to manage my AI-assisted development workflow?",
            },
          },
        ],
      }),
    });
  }

  /**
   * Set up MCP protocol request handlers
   */
  private setupRequestHandlers(): void {
    // Tools handlers
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = Array.from(this.tools.values()).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));

      log.debug("Listing tools", { toolCount: tools.length });
      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      
      log.debug("Calling tool", { name, args });

      const tool = this.tools.get(name);
      if (!tool) {
        throw new Error(`Unknown tool: ${name}`);
      }

      try {
        const result = await tool.handler(args || {});
        
        // Ensure result is returned in proper format
        if (typeof result === "string") {
          return {
            content: [
              {
                type: "text",
                text: result,
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }
      } catch (error) {
        const errorMessage = getErrorMessage(error as any);
        log.error("Tool execution failed", { name, error: errorMessage });
        
        return {
          content: [
            {
              type: "text",
              text: `Error executing tool '${name}': ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    });

    // Resources handlers
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const resources = Array.from(this.resources.values()).map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
      }));

      log.debug("Listing resources", { resourceCount: resources.length });
      return { resources };
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      
      log.debug("Reading resource", { uri });

      const resource = this.resources.get(uri);
      if (!resource) {
        throw new Error(`Unknown resource: ${uri}`);
      }

      try {
        const result = await resource.handler();
        return {
          contents: [
            {
              uri,
              mimeType: resource.mimeType,
              ...result,
            },
          ],
        };
      } catch (error) {
        const errorMessage = getErrorMessage(error as any);
        log.error("Resource read failed", { uri, error: errorMessage });
        throw new Error(`Failed to read resource '${uri}': ${errorMessage}`);
      }
    });

    // Prompts handlers
    this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
      const prompts = Array.from(this.prompts.values()).map((prompt) => ({
        name: prompt.name,
        description: prompt.description,
        arguments: prompt.arguments || [],
      }));

      log.debug("Listing prompts", { promptCount: prompts.length });
      return { prompts };
    });

    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      
      log.debug("Getting prompt", { name, args });

      const prompt = this.prompts.get(name);
      if (!prompt) {
        throw new Error(`Unknown prompt: ${name}`);
      }

      try {
        const result = await prompt.handler(args || {});
        return result;
      } catch (error) {
        const errorMessage = getErrorMessage(error as any);
        log.error("Prompt execution failed", { name, error: errorMessage });
        throw new Error(`Failed to execute prompt '${name}': ${errorMessage}`);
      }
    });
  }

  /**
   * Set up event handlers for the server
   */
  private setupEventHandlers(): void {
    this.server.onclose = () => {
      log.agent("MCP Server connection closed");
    };

    this.server.onerror = (error) => {
      log.error("MCP Server error", { error: getErrorMessage(error) });
    };

    this.server.oninitialized = () => {
      log.agent("MCP Server initialized");
    };
  }

  /**
   * Add a tool to the server
   * @param tool Tool definition with name, description, schema, and handler
   */
  addTool(tool: ToolDefinition): void {
    log.debug("Registering MCP tool", {
      name: tool.name,
      description: tool.description,
      hasInputSchema: !!tool.inputSchema,
    });

    this.tools.set(tool.name, tool);
  }

  /**
   * Add a resource to the server
   * @param resource Resource definition with URI, name, description, and handler
   */
  addResource(resource: ResourceDefinition): void {
    log.debug("Registering MCP resource", {
      uri: resource.uri,
      name: resource.name,
      description: resource.description,
      mimeType: resource.mimeType,
    });

    this.resources.set(resource.uri, resource);
  }

  /**
   * Add a prompt to the server
   * @param prompt Prompt definition with name, description, and handler
   */
  addPrompt(prompt: PromptDefinition): void {
    log.debug("Registering MCP prompt", {
      name: prompt.name,
      description: prompt.description,
      argumentCount: prompt.arguments?.length || 0,
    });

    this.prompts.set(prompt.name, prompt);
  }

  /**
   * Start the server with stdio transport
   */
  async start(): Promise<void> {
    try {
      await this.server.connect(this.transport);
      
      log.agent("Minsky MCP Server started with stdio transport");
      
      // Debug log of registered items
      log.debug("MCP Server registered items", {
        toolCount: this.tools.size,
        resourceCount: this.resources.size,
        promptCount: this.prompts.size,
        tools: Array.from(this.tools.keys()),
        resources: Array.from(this.resources.keys()),
        prompts: Array.from(this.prompts.keys()),
      });
    } catch (error) {
      log.error("Failed to start Minsky MCP Server", {
        error: getErrorMessage(error as any),
        stack: error instanceof Error ? (error as any).stack : undefined,
      });

      throw error;
    }
  }

  /**
   * Get access to the underlying MCP server instance
   */
  getServer(): Server {
    return this.server;
  }

  /**
   * Get the project context for this server instance
   * @returns The project context containing repository information
   */
  getProjectContext(): ProjectContext {
    return this.projectContext;
  }

  /**
   * Get the registered tools
   * @returns Map of tool names to tool definitions
   */
  getTools(): Map<string, ToolDefinition> {
    return new Map(this.tools);
  }

  /**
   * Get the registered resources
   * @returns Map of resource URIs to resource definitions
   */
  getResources(): Map<string, ResourceDefinition> {
    return new Map(this.resources);
  }

  /**
   * Get the registered prompts
   * @returns Map of prompt names to prompt definitions
   */
  getPrompts(): Map<string, PromptDefinition> {
    return new Map(this.prompts);
  }
}
