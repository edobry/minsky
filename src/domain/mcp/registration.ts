import * as path from "path";
import { DEFAULT_DEV_PORT } from "../../utils/constants";
import type { FsLike } from "../interfaces/fs-like";
import { createRealFs } from "../interfaces/real-fs";
import { createFileIfNotExists } from "../init/file-system";

/**
 * Abstraction for an MCP client that can be registered with Minsky.
 * Each implementation knows how to generate its config file content
 * and where to write it.
 */
export interface ClientRegistrar {
  name: string;
  generateConfig(transport: string, port?: number, host?: string): string;
  configPath(projectRoot: string): string;
}

/**
 * Registrar for the Cursor editor MCP client.
 * Produces `.cursor/mcp.json` content and path.
 */
export class CursorRegistrar implements ClientRegistrar {
  readonly name = "cursor";

  generateConfig(transport: string, port?: number, host?: string): string {
    const resolvedPort = port || DEFAULT_DEV_PORT;
    const resolvedHost = host || "localhost";

    if (transport === "stdio") {
      return JSON.stringify(
        {
          mcpServers: {
            "minsky-server": {
              command: "minsky",
              args: ["mcp", "start"],
            },
          },
        },
        undefined,
        2
      );
    }

    if (transport === "sse") {
      return JSON.stringify(
        {
          mcpServers: {
            "minsky-server": {
              command: "minsky",
              args: [
                "mcp",
                "start",
                "--sse",
                "--port",
                String(resolvedPort),
                "--host",
                resolvedHost,
              ],
            },
          },
        },
        undefined,
        2
      );
    }

    if (transport === "httpStream") {
      return JSON.stringify(
        {
          mcpServers: {
            "minsky-server": {
              command: "minsky",
              args: [
                "mcp",
                "start",
                "--http-stream",
                "--port",
                String(resolvedPort),
                "--host",
                resolvedHost,
              ],
            },
          },
        },
        undefined,
        2
      );
    }

    // Default fallback for unknown transport — treat as stdio
    return JSON.stringify(
      {
        mcpServers: {
          "minsky-server": {
            command: "minsky",
            args: ["mcp", "start"],
          },
        },
      },
      undefined,
      2
    );
  }

  configPath(projectRoot: string): string {
    return path.join(projectRoot, ".cursor", "mcp.json");
  }
}

/**
 * Returns the registrar for the given client name.
 * Throws a descriptive error for unrecognized clients.
 */
export function getRegistrar(client: string): ClientRegistrar {
  switch (client) {
    case "cursor":
      return new CursorRegistrar();
    default:
      throw new Error(`MCP client "${client}" is not yet supported. Supported clients: cursor`);
  }
}

/**
 * Orchestrates registering Minsky as an MCP server with the given client.
 * Gets the registrar, generates the config, and writes it to the correct path.
 */
export async function registerWithClient(
  projectRoot: string,
  mcpConfig: { transport: string; port?: number; host?: string },
  client = "cursor",
  fileSystem: FsLike = createRealFs(),
  overwrite = false
): Promise<void> {
  const registrar = getRegistrar(client);
  const content = registrar.generateConfig(mcpConfig.transport, mcpConfig.port, mcpConfig.host);
  const filePath = registrar.configPath(projectRoot);
  await createFileIfNotExists(filePath, content, overwrite, fileSystem);
}
