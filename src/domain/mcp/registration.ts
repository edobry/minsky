import * as path from "path";
import { homedir } from "os";
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
  /**
   * Whether registration should merge the new server entry into an existing
   * config file rather than overwriting the entire file.
   *
   * Clients that own their config file (e.g. Cursor's `.cursor/mcp.json`)
   * set this to false. Clients that share a global config file (e.g. Claude
   * Desktop's `claude_desktop_config.json`) set this to true.
   */
  readonly mergeConfig: boolean;
}

/**
 * Base registrar for clients that use the standard mcpServers JSON format.
 * Subclasses only need to provide name, configPath, and optionally mergeConfig.
 */
export abstract class McpServersJsonRegistrar implements ClientRegistrar {
  abstract readonly name: string;
  abstract configPath(projectRoot: string): string;

  /** Override to true in subclasses that share a global config file. */
  readonly mergeConfig: boolean = false;

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
}

/**
 * Registrar for the Cursor editor MCP client.
 * Produces `.cursor/mcp.json` content and path.
 */
export class CursorRegistrar extends McpServersJsonRegistrar {
  readonly name = "cursor";

  configPath(projectRoot: string): string {
    return path.join(projectRoot, ".cursor", "mcp.json");
  }
}

/**
 * Registrar for the Claude Desktop MCP client.
 *
 * Claude Desktop uses a global (user-level) config file rather than a
 * per-project one, so registration merges the minsky-server entry into any
 * existing config rather than overwriting it.
 *
 * Config file locations:
 * - macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
 * - Windows: %APPDATA%\Claude\claude_desktop_config.json
 * - Linux:   ~/.config/Claude/claude_desktop_config.json
 */
export class ClaudeDesktopRegistrar extends McpServersJsonRegistrar {
  readonly name = "claude-desktop";
  override readonly mergeConfig = true;

  configPath(_projectRoot: string): string {
    const home = homedir();
    if (process.platform === "darwin") {
      return path.join(
        home,
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json"
      );
    } else if (process.platform === "win32") {
      return path.join(
        process.env.APPDATA || path.join(home, "AppData", "Roaming"),
        "Claude",
        "claude_desktop_config.json"
      );
    }
    // Linux
    return path.join(home, ".config", "Claude", "claude_desktop_config.json");
  }
}

/**
 * Registrar for the VS Code editor MCP client.
 *
 * VS Code uses a "servers" root key (not "mcpServers") in its MCP config.
 * Config file is workspace-scoped at `.vscode/mcp.json`.
 */
export class VSCodeRegistrar implements ClientRegistrar {
  readonly name = "vscode";
  readonly mergeConfig = false; // workspace-scoped, Minsky owns the file

  generateConfig(transport: string, port?: number, host?: string): string {
    const resolvedPort = port || DEFAULT_DEV_PORT;
    const resolvedHost = host || "localhost";

    const args = ["mcp", "start"];
    if (transport === "sse") {
      args.push("--sse", "--port", String(resolvedPort), "--host", resolvedHost);
    } else if (transport === "httpStream") {
      args.push("--http-stream", "--port", String(resolvedPort), "--host", resolvedHost);
    }

    return JSON.stringify(
      {
        servers: {
          "minsky-server": {
            command: "minsky",
            args,
          },
        },
      },
      undefined,
      2
    );
  }

  configPath(projectRoot: string): string {
    return path.join(projectRoot, ".vscode", "mcp.json");
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
    case "claude-desktop":
      return new ClaudeDesktopRegistrar();
    case "vscode":
      return new VSCodeRegistrar();
    default:
      throw new Error(
        `MCP client "${client}" is not yet supported. Supported clients: cursor, claude-desktop, vscode`
      );
  }
}

/**
 * Orchestrates registering Minsky as an MCP server with the given client.
 *
 * For clients with mergeConfig=true (e.g. Claude Desktop), reads the existing
 * config, merges the minsky-server entry into mcpServers, and writes it back.
 * For other clients, creates or overwrites the config file outright.
 */
export async function registerWithClient(
  projectRoot: string,
  mcpConfig: { transport: string; port?: number; host?: string },
  client = "cursor",
  fileSystem: FsLike = createRealFs(),
  overwrite = false
): Promise<void> {
  const registrar = getRegistrar(client);
  const newConfigJson = registrar.generateConfig(
    mcpConfig.transport,
    mcpConfig.port,
    mcpConfig.host
  );
  const filePath = registrar.configPath(projectRoot);

  if (registrar.mergeConfig && (await fileSystem.exists(filePath))) {
    // Merge: read existing config, update the minsky-server entry, write back
    const existing = await fileSystem.readFile(filePath, "utf-8");
    const existingParsed = JSON.parse(existing) as Record<string, unknown>;
    const newParsed = JSON.parse(newConfigJson) as {
      mcpServers: Record<string, unknown>;
    };

    const merged = {
      ...existingParsed,
      mcpServers: {
        ...(existingParsed.mcpServers as Record<string, unknown> | undefined),
        ...newParsed.mcpServers,
      },
    };
    await fileSystem.writeFile(filePath, JSON.stringify(merged, undefined, 2));
  } else {
    await createFileIfNotExists(filePath, newConfigJson, overwrite, fileSystem);
  }
}
