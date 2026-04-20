import { DEFAULT_DEV_PORT } from "../../utils/constants";
import { z } from "zod";
import { stringify as yamlStringify } from "yaml";
import { enumSchemas } from "../configuration/schemas/base";
import type { ResolvedRepositoryConfig } from "../session/repository-backend-detection";

export interface McpOptions {
  enabled?: boolean;
  transport?: "stdio" | "sse" | "httpStream";
  port?: number;
  host?: string;
}

/**
 * Returns the content for the main Minsky config file in YAML format
 */
export function getMinskyConfigContentYaml(
  backend: z.infer<typeof enumSchemas.backendType>,
  repository?: ResolvedRepositoryConfig
): string {
  const config: Record<string, unknown> = {
    tasks: {
      backend: backend,
      strictIds: false,
    },
    sessiondb: {
      backend: "sqlite",
    },
    logger: {
      mode: "auto",
      level: "info",
      enableAgentLogs: false,
    },
  };

  if (repository) {
    const repoSection: Record<string, unknown> = { backend: repository.backend };
    if (repository.url) {
      repoSection.url = repository.url;
    }
    if (repository.github) {
      repoSection.github = repository.github;
    }
    config.repository = repoSection;
  }

  return yamlStringify(config);
}

/**
 * Returns the content for the local (machine-specific, gitignored) Minsky config file.
 * Currently stores workspace.mainPath so session_start can use --reference cloning.
 */
export function getLocalConfigContentYaml(repoPath: string): string {
  return yamlStringify({ workspace: { mainPath: repoPath } });
}

/**
 * Returns the content for the MCP config file
 */
export function getMCPConfigContent(mcpOptions?: McpOptions): string {
  const transport = mcpOptions?.transport || "stdio";
  const port = mcpOptions?.port || DEFAULT_DEV_PORT;
  const host = mcpOptions?.host || "localhost";

  // Base configuration for stdio transport
  if (transport === "stdio") {
    return JSON.stringify(
      {
        mcpServers: {
          "minsky-server": {
            _command: "minsky",
            _args: ["mcp", "start"],
          },
        },
      },
      undefined,
      2
    );
  }

  // Configuration for SSE transport
  else if (transport === "sse") {
    return JSON.stringify(
      {
        mcpServers: {
          "minsky-server": {
            _command: "minsky",
            _args: ["mcp", "start", "--sse", "--port", String(port), "--host", host],
          },
        },
      },
      undefined,
      2
    );
  }

  // Configuration for HTTP Stream transport
  else if (transport === "httpStream") {
    return JSON.stringify(
      {
        mcpServers: {
          "minsky-server": {
            _command: "minsky",
            _args: ["mcp", "start", "--http-stream", "--port", String(port), "--host", host],
          },
        },
      },
      undefined,
      2
    );
  }

  // Default fallback (shouldn't be reached with proper type checking)
  return JSON.stringify(
    {
      mcpServers: {
        "minsky-server": {
          _command: "minsky",
          _args: ["mcp", "start"],
        },
      },
    },
    undefined,
    2
  );
}

/**
 * Returns the content for the MCP usage rule
 */
export function getMCPRuleContent(): string {
  return `# MCP Usage

This rule outlines the usage of the Minsky Control Protocol (MCP) for AI agent interaction.

- **Purpose**: Provides a stable, machine-readable interface for AI agents to interact with the Minsky CLI.
- **Transport**: Can be configured for \`stdio\`, \`sse\`, or \`httpStream\`.
- **Commands**: All shared commands are available via MCP.

See README-MCP.md for detailed protocol specifications.
`;
}
