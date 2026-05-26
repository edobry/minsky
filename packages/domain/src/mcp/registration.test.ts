/**
 * Tests for MCP client registration module.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import * as path from "path";
import * as os from "os";

// Shared TOML assertion constants (avoids magic-string-duplication lint warnings)
const TOML_MINSKY_SECTION = "[mcp_servers.minsky-server]";
const TOML_COMMAND_MINSKY = 'command = "minsky"';
import {
  CursorRegistrar,
  ClaudeDesktopRegistrar,
  McpServersJsonRegistrar,
  VSCodeRegistrar,
  WindsurfRegistrar,
  JunieRegistrar,
  CodexRegistrar,
  OpenHandsRegistrar,
  getRegistrar,
  registerWithClient,
} from "./registration";
import { createMockFs } from "../interfaces/mock-fs";
import type { MockFs } from "../interfaces/mock-fs";

describe("CursorRegistrar", () => {
  const registrar = new CursorRegistrar();

  describe("generateConfig", () => {
    test("stdio transport produces correct JSON", () => {
      const content = registrar.generateConfig("stdio");
      const parsed = JSON.parse(content);

      expect(parsed.mcpServers["minsky-server"].command).toBe("minsky");
      expect(parsed.mcpServers["minsky-server"].args).toEqual(["mcp", "start"]);
    });

    test("httpStream transport includes correct args with port and host", () => {
      const content = registrar.generateConfig("httpStream", 3000, "localhost");
      const parsed = JSON.parse(content);

      expect(parsed.mcpServers["minsky-server"].command).toBe("minsky");
      expect(parsed.mcpServers["minsky-server"].args).toEqual([
        "mcp",
        "start",
        "--http-stream",
        "--port",
        "3000",
        "--host",
        "localhost",
      ]);
    });

    test("sse transport includes correct args with port and host", () => {
      const content = registrar.generateConfig("sse", 4000, "0.0.0.0");
      const parsed = JSON.parse(content);

      expect(parsed.mcpServers["minsky-server"].args).toEqual([
        "mcp",
        "start",
        "--sse",
        "--port",
        "4000",
        "--host",
        "0.0.0.0",
      ]);
    });

    test("unknown transport falls back to stdio-style config", () => {
      const content = registrar.generateConfig("unknown-transport");
      const parsed = JSON.parse(content);

      expect(parsed.mcpServers["minsky-server"].command).toBe("minsky");
      expect(parsed.mcpServers["minsky-server"].args).toEqual(["mcp", "start"]);
    });

    test("httpStream uses DEFAULT_DEV_PORT when port not specified", () => {
      const content = registrar.generateConfig("httpStream");
      const parsed = JSON.parse(content);

      // DEFAULT_DEV_PORT is 3000
      expect(parsed.mcpServers["minsky-server"].args).toContain("3000");
    });
  });

  describe("configPath", () => {
    test("returns correct path for given project root", () => {
      expect(registrar.configPath("/project")).toBe(path.join("/project", ".cursor", "mcp.json"));
    });

    test("handles nested project roots", () => {
      expect(registrar.configPath("/home/user/my-project")).toBe(
        path.join("/home/user/my-project", ".cursor", "mcp.json")
      );
    });
  });

  test("mergeConfig is false (owns its file)", () => {
    expect(registrar.mergeConfig).toBe(false);
  });
});

describe("ClaudeDesktopRegistrar", () => {
  const registrar = new ClaudeDesktopRegistrar();

  describe("generateConfig — inherits McpServersJsonRegistrar logic", () => {
    test("stdio transport produces correct JSON", () => {
      const content = registrar.generateConfig("stdio");
      const parsed = JSON.parse(content);

      expect(parsed.mcpServers["minsky-server"].command).toBe("minsky");
      expect(parsed.mcpServers["minsky-server"].args).toEqual(["mcp", "start"]);
    });

    test("httpStream transport includes correct args", () => {
      const content = registrar.generateConfig("httpStream", 3000, "localhost");
      const parsed = JSON.parse(content);

      expect(parsed.mcpServers["minsky-server"].args).toEqual([
        "mcp",
        "start",
        "--http-stream",
        "--port",
        "3000",
        "--host",
        "localhost",
      ]);
    });
  });

  describe("configPath", () => {
    test("returns OS-appropriate path (does not include projectRoot)", () => {
      const configPath = registrar.configPath("/any-project-root");
      // Should be under the user's home directory, not under the project root
      expect(configPath).not.toContain("/any-project-root");
      expect(configPath).toContain("claude_desktop_config.json");
      expect(configPath).toContain("Claude");
      // Should be an absolute path under homedir
      expect(configPath.startsWith(os.homedir())).toBe(true);
    });

    test("config path ends with claude_desktop_config.json", () => {
      const configPath = registrar.configPath("/irrelevant");
      expect(configPath.endsWith("claude_desktop_config.json")).toBe(true);
    });
  });

  test("mergeConfig is true (shares global config file)", () => {
    expect(registrar.mergeConfig).toBe(true);
  });
});

describe("VSCodeRegistrar", () => {
  const registrar = new VSCodeRegistrar();

  describe("generateConfig", () => {
    test("stdio transport produces correct JSON with 'servers' root key", () => {
      const content = registrar.generateConfig("stdio");
      const parsed = JSON.parse(content);

      expect(parsed.servers).toBeDefined();
      expect(parsed.mcpServers).toBeUndefined();
      expect(parsed.servers["minsky-server"].command).toBe("minsky");
      expect(parsed.servers["minsky-server"].args).toEqual(["mcp", "start"]);
    });

    test("httpStream transport includes correct args with port and host", () => {
      const content = registrar.generateConfig("httpStream", 3000, "localhost");
      const parsed = JSON.parse(content);

      expect(parsed.servers["minsky-server"].command).toBe("minsky");
      expect(parsed.servers["minsky-server"].args).toEqual([
        "mcp",
        "start",
        "--http-stream",
        "--port",
        "3000",
        "--host",
        "localhost",
      ]);
    });

    test("sse transport includes correct args with port and host", () => {
      const content = registrar.generateConfig("sse", 4000, "0.0.0.0");
      const parsed = JSON.parse(content);

      expect(parsed.servers["minsky-server"].args).toEqual([
        "mcp",
        "start",
        "--sse",
        "--port",
        "4000",
        "--host",
        "0.0.0.0",
      ]);
    });

    test("uses 'servers' not 'mcpServers' — VS Code rejects mcpServers key", () => {
      const content = registrar.generateConfig("stdio");
      const parsed = JSON.parse(content);

      expect(parsed.mcpServers).toBeUndefined();
      expect(parsed.servers).toBeDefined();
    });
  });

  describe("configPath", () => {
    test("returns correct .vscode/mcp.json path for given project root", () => {
      expect(registrar.configPath("/project")).toBe(path.join("/project", ".vscode", "mcp.json"));
    });
  });

  test("mergeConfig is false (workspace-scoped, Minsky owns the file)", () => {
    expect(registrar.mergeConfig).toBe(false);
  });

  test("is NOT an instance of McpServersJsonRegistrar — direct implementor", () => {
    expect(registrar).not.toBeInstanceOf(McpServersJsonRegistrar);
  });
});

describe("WindsurfRegistrar", () => {
  const registrar = new WindsurfRegistrar();

  describe("generateConfig — inherits McpServersJsonRegistrar logic", () => {
    test("stdio transport produces correct mcpServers JSON", () => {
      const content = registrar.generateConfig("stdio");
      const parsed = JSON.parse(content);

      expect(parsed.mcpServers["minsky-server"].command).toBe("minsky");
      expect(parsed.mcpServers["minsky-server"].args).toEqual(["mcp", "start"]);
    });
  });

  describe("configPath", () => {
    test("returns path under ~/.codeium/windsurf/ (ignores projectRoot)", () => {
      const configPath = registrar.configPath("/unused");
      expect(configPath).not.toContain("/unused");
      expect(configPath.startsWith(os.homedir())).toBe(true);
      expect(configPath).toContain(".codeium");
      expect(configPath).toContain("windsurf");
      expect(configPath.endsWith("mcp_config.json")).toBe(true);
    });
  });

  test("mergeConfig is true (global config, may have other servers)", () => {
    expect(registrar.mergeConfig).toBe(true);
  });

  test("is an instance of McpServersJsonRegistrar", () => {
    expect(registrar).toBeInstanceOf(McpServersJsonRegistrar);
  });
});

describe("JunieRegistrar", () => {
  const registrar = new JunieRegistrar();

  describe("configPath", () => {
    test("returns .junie/mcp/mcp.json under the project root", () => {
      expect(registrar.configPath("/project")).toBe(
        path.join("/project", ".junie", "mcp", "mcp.json")
      );
    });
  });

  test("mergeConfig is false (project-scoped)", () => {
    expect(registrar.mergeConfig).toBe(false);
  });

  test("is an instance of McpServersJsonRegistrar", () => {
    expect(registrar).toBeInstanceOf(McpServersJsonRegistrar);
  });
});

describe("CodexRegistrar", () => {
  const registrar = new CodexRegistrar();

  describe("generateConfig", () => {
    test("stdio transport produces valid TOML with [mcp_servers.minsky-server] header", () => {
      const content = registrar.generateConfig("stdio");

      expect(content).toContain(TOML_MINSKY_SECTION);
      expect(content).toContain(TOML_COMMAND_MINSKY);
      expect(content).toContain('"mcp"');
      expect(content).toContain('"start"');
    });

    test("httpStream transport includes --http-stream in args", () => {
      const content = registrar.generateConfig("httpStream", 3000, "localhost");

      expect(content).toContain(TOML_MINSKY_SECTION);
      expect(content).toContain('"--http-stream"');
      expect(content).toContain('"3000"');
      expect(content).toContain('"localhost"');
    });

    test("sse transport includes --sse in args", () => {
      const content = registrar.generateConfig("sse", 4000, "0.0.0.0");

      expect(content).toContain('"--sse"');
      expect(content).toContain('"4000"');
      expect(content).toContain('"0.0.0.0"');
    });
  });

  describe("configPath", () => {
    test("returns .codex/config.toml under project root", () => {
      expect(registrar.configPath("/project")).toBe(path.join("/project", ".codex", "config.toml"));
    });
  });

  test("mergeConfig is true (Codex config has other settings)", () => {
    expect(registrar.mergeConfig).toBe(true);
  });

  test("is NOT an instance of McpServersJsonRegistrar", () => {
    expect(registrar).not.toBeInstanceOf(McpServersJsonRegistrar);
  });
});

describe("OpenHandsRegistrar", () => {
  const registrar = new OpenHandsRegistrar();

  describe("generateConfig", () => {
    test("stdio transport produces TOML with [mcp] section and stdio_servers array", () => {
      const content = registrar.generateConfig("stdio");

      expect(content).toContain("[mcp]");
      expect(content).toContain("stdio_servers");
      expect(content).toContain('"minsky-server"');
      expect(content).toContain('"minsky"');
    });

    test("httpStream transport produces TOML with shttp_servers and URL", () => {
      const content = registrar.generateConfig("httpStream", 3000, "localhost");

      expect(content).toContain("[mcp]");
      expect(content).toContain("shttp_servers");
      expect(content).toContain("http://localhost:3000/mcp");
    });

    test("sse transport produces TOML with shttp_servers", () => {
      const content = registrar.generateConfig("sse", 4000, "0.0.0.0");

      expect(content).toContain("shttp_servers");
      expect(content).toContain("http://0.0.0.0:4000/mcp");
    });
  });

  describe("configPath", () => {
    test("returns config.toml at project root", () => {
      expect(registrar.configPath("/project")).toBe(path.join("/project", "config.toml"));
    });
  });

  test("mergeConfig is true (OpenHands config has other settings)", () => {
    expect(registrar.mergeConfig).toBe(true);
  });

  test("is NOT an instance of McpServersJsonRegistrar", () => {
    expect(registrar).not.toBeInstanceOf(McpServersJsonRegistrar);
  });
});

describe("McpServersJsonRegistrar (abstract base)", () => {
  test("CursorRegistrar is an instance of McpServersJsonRegistrar", () => {
    expect(new CursorRegistrar()).toBeInstanceOf(McpServersJsonRegistrar);
  });

  test("ClaudeDesktopRegistrar is an instance of McpServersJsonRegistrar", () => {
    expect(new ClaudeDesktopRegistrar()).toBeInstanceOf(McpServersJsonRegistrar);
  });
});

describe("getRegistrar", () => {
  test("returns CursorRegistrar for 'cursor'", () => {
    const r = getRegistrar("cursor");
    expect(r).toBeInstanceOf(CursorRegistrar);
    expect(r.name).toBe("cursor");
  });

  test("returns ClaudeDesktopRegistrar for 'claude-desktop'", () => {
    const r = getRegistrar("claude-desktop");
    expect(r).toBeInstanceOf(ClaudeDesktopRegistrar);
    expect(r.name).toBe("claude-desktop");
  });

  test("returns VSCodeRegistrar for 'vscode'", () => {
    const r = getRegistrar("vscode");
    expect(r).toBeInstanceOf(VSCodeRegistrar);
    expect(r.name).toBe("vscode");
  });

  test("returns WindsurfRegistrar for 'windsurf'", () => {
    const r = getRegistrar("windsurf");
    expect(r).toBeInstanceOf(WindsurfRegistrar);
    expect(r.name).toBe("windsurf");
  });

  test("returns JunieRegistrar for 'junie'", () => {
    const r = getRegistrar("junie");
    expect(r).toBeInstanceOf(JunieRegistrar);
    expect(r.name).toBe("junie");
  });

  test("returns CodexRegistrar for 'codex'", () => {
    const r = getRegistrar("codex");
    expect(r).toBeInstanceOf(CodexRegistrar);
    expect(r.name).toBe("codex");
  });

  test("returns OpenHandsRegistrar for 'openhands'", () => {
    const r = getRegistrar("openhands");
    expect(r).toBeInstanceOf(OpenHandsRegistrar);
    expect(r.name).toBe("openhands");
  });

  test("throws descriptive error for unsupported client listing all 7 clients", () => {
    expect(() => getRegistrar("unknown")).toThrow(
      'MCP client "unknown" is not yet supported. Supported clients: cursor, claude-desktop, vscode, windsurf, junie, codex, openhands'
    );
  });
});

describe("registerWithClient", () => {
  let mockFs: MockFs;

  beforeEach(() => {
    mockFs = createMockFs();
  });

  test("writes cursor mcp.json to correct path", async () => {
    await registerWithClient("/my-project", { transport: "stdio" }, "cursor", mockFs);

    const expectedPath = path.join("/my-project", ".cursor", "mcp.json");
    expect(mockFs.files.has(expectedPath)).toBe(true);
  });

  test("written content is valid JSON with correct structure", async () => {
    await registerWithClient("/my-project", { transport: "stdio" }, "cursor", mockFs);

    const content = mockFs.files.get(path.join("/my-project", ".cursor", "mcp.json")) ?? "";
    const parsed = JSON.parse(content);
    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.mcpServers["minsky-server"]).toBeDefined();
  });

  test("throws if file already exists and overwrite is false", async () => {
    await registerWithClient("/my-project", { transport: "stdio" }, "cursor", mockFs);

    await expect(
      registerWithClient("/my-project", { transport: "stdio" }, "cursor", mockFs, false)
    ).rejects.toThrow(/already exists/);
  });

  test("overwrites existing file when overwrite is true", async () => {
    await registerWithClient("/my-project", { transport: "stdio" }, "cursor", mockFs);

    await expect(
      registerWithClient("/my-project", { transport: "sse", port: 9000 }, "cursor", mockFs, true)
    ).resolves.toBeUndefined();

    const content = mockFs.files.get(path.join("/my-project", ".cursor", "mcp.json")) ?? "";
    const parsed = JSON.parse(content);
    expect(parsed.mcpServers["minsky-server"].args).toContain("--sse");
  });

  describe("claude-desktop config merging", () => {
    const registrar = new ClaudeDesktopRegistrar();

    test("creates new file if config file does not exist", async () => {
      await registerWithClient("/any-root", { transport: "stdio" }, "claude-desktop", mockFs);

      const configPath = registrar.configPath("/any-root");
      expect(mockFs.files.has(configPath)).toBe(true);
      const parsed = JSON.parse(mockFs.files.get(configPath) ?? "");
      expect(parsed.mcpServers["minsky-server"]).toBeDefined();
    });

    test("merges minsky-server into existing config preserving other servers", async () => {
      const configPath = registrar.configPath("/any-root");
      const existingConfig = JSON.stringify({
        mcpServers: {
          "other-server": {
            command: "other",
            args: ["run"],
          },
        },
        someOtherKey: "preserved",
      });
      mockFs.files.set(configPath, existingConfig);
      // Ensure the parent directory is recognized
      mockFs.directories.add(path.dirname(configPath));

      await registerWithClient("/any-root", { transport: "stdio" }, "claude-desktop", mockFs);

      const parsed = JSON.parse(mockFs.files.get(configPath) ?? "");
      // Existing server preserved
      expect(parsed.mcpServers["other-server"]).toBeDefined();
      // Minsky server added
      expect(parsed.mcpServers["minsky-server"]).toBeDefined();
      expect(parsed.mcpServers["minsky-server"].command).toBe("minsky");
      // Other top-level keys preserved
      expect(parsed.someOtherKey).toBe("preserved");
    });

    test("overwrites existing minsky-server entry when merging", async () => {
      const configPath = registrar.configPath("/any-root");
      const existingConfig = JSON.stringify({
        mcpServers: {
          "minsky-server": {
            command: "old-command",
            args: ["old-args"],
          },
        },
      });
      mockFs.files.set(configPath, existingConfig);
      mockFs.directories.add(path.dirname(configPath));

      await registerWithClient(
        "/any-root",
        { transport: "httpStream", port: 4242 },
        "claude-desktop",
        mockFs
      );

      const parsed = JSON.parse(mockFs.files.get(configPath) ?? "");
      expect(parsed.mcpServers["minsky-server"].args).toContain("--http-stream");
      expect(parsed.mcpServers["minsky-server"].args).toContain("4242");
    });
  });

  describe("codex TOML merging", () => {
    test("appends minsky-server section to existing TOML config", async () => {
      const configPath = path.join("/my-project", ".codex", "config.toml");
      const existingToml = `model = "gpt-4"\napproval_mode = "suggest"\n`;
      mockFs.files.set(configPath, existingToml);
      mockFs.directories.add(path.dirname(configPath));

      await registerWithClient("/my-project", { transport: "stdio" }, "codex", mockFs);

      const result = mockFs.files.get(configPath) ?? "";
      // Existing content preserved
      expect(result).toContain('model = "gpt-4"');
      expect(result).toContain('approval_mode = "suggest"');
      // New section appended
      expect(result).toContain(TOML_MINSKY_SECTION);
    });

    test("overwrites when minsky-server already exists in TOML", async () => {
      const configPath = path.join("/my-project", ".codex", "config.toml");
      const existingToml = `[mcp_servers.minsky-server]\ncommand = "old"\n`;
      mockFs.files.set(configPath, existingToml);
      mockFs.directories.add(path.dirname(configPath));

      await registerWithClient("/my-project", { transport: "stdio" }, "codex", mockFs);

      const result = mockFs.files.get(configPath) ?? "";
      // Old content replaced entirely
      expect(result).not.toContain('command = "old"');
      expect(result).toContain(TOML_COMMAND_MINSKY);
    });
  });

  describe("openhands TOML merging", () => {
    test("appends mcp section to existing TOML config", async () => {
      const configPath = path.join("/my-project", "config.toml");
      const existingToml = `[core]\nworkspace_base = "/workspace"\n`;
      mockFs.files.set(configPath, existingToml);
      mockFs.directories.add(path.dirname(configPath));

      await registerWithClient("/my-project", { transport: "stdio" }, "openhands", mockFs);

      const result = mockFs.files.get(configPath) ?? "";
      // Existing content preserved
      expect(result).toContain("[core]");
      expect(result).toContain('workspace_base = "/workspace"');
      // New section appended
      expect(result).toContain("[mcp]");
      expect(result).toContain("minsky-server");
    });

    test("overwrites when minsky-server already exists", async () => {
      const configPath = path.join("/my-project", "config.toml");
      const existingToml = `[mcp]\nstdio_servers = [\n  {name = "minsky-server", command = "old"}\n]\n`;
      mockFs.files.set(configPath, existingToml);
      mockFs.directories.add(path.dirname(configPath));

      await registerWithClient("/my-project", { transport: "stdio" }, "openhands", mockFs);

      const result = mockFs.files.get(configPath) ?? "";
      expect(result).not.toContain('command = "old"');
      expect(result).toContain(TOML_COMMAND_MINSKY);
    });
  });
});
