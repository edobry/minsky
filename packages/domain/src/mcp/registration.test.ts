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
  ClaudeCodeRegistrar,
  McpServersJsonRegistrar,
  VSCodeRegistrar,
  WindsurfRegistrar,
  JunieRegistrar,
  CodexRegistrar,
  OpenHandsRegistrar,
  getRegistrar,
  registerWithClient,
  detectJsonIndent,
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

describe("ClaudeCodeRegistrar", () => {
  const registrar = new ClaudeCodeRegistrar();

  describe("generateConfig for claude-code — emits the SHIM form, not the inherited stdio-spawn form (PR #3423 R2)", () => {
    test("produces the shim invocation: mcp shim --url <daemon-url>", () => {
      const content = registrar.generateConfig("stdio");
      const parsed = JSON.parse(content);

      expect(parsed.mcpServers["minsky-server"].command).toBe("minsky");
      expect(parsed.mcpServers["minsky-server"].args).toEqual([
        "mcp",
        "shim",
        "--url",
        "http://127.0.0.1:48765/mcp",
      ]);
    });

    test("never emits the legacy stdio-spawn form (no bare 'mcp start')", () => {
      const content = registrar.generateConfig("stdio");
      const parsed = JSON.parse(content);
      expect(parsed.mcpServers["minsky-server"].args).not.toContain("start");
    });

    test("ignores transport/port/host -- those describe THIS project's minsky mcp start, not the daemon endpoint", () => {
      const stdioContent = registrar.generateConfig("stdio");
      const httpStreamContent = registrar.generateConfig("httpStream", 3000, "localhost");
      const sseContent = registrar.generateConfig("sse", 4000, "0.0.0.0");

      // All three produce byte-identical output -- the shim entry does not
      // vary with the args that would change a stdio-spawn's own bind config.
      expect(stdioContent).toBe(httpStreamContent);
      expect(stdioContent).toBe(sseContent);
    });

    test("command is 'minsky', which resolves through the bin wrapper that can reach 'mcp shim' (local-http-config.ts:106-119)", () => {
      // `mcp shim` is not a normal CLI subcommand -- only an invocation
      // through scripts/cli-entry.ts's bin wrapper can reach it. `command:
      // "minsky"` is that invocation; `bun dist/minsky.js` or `bun
      // src/cli.ts` forms would NOT be (measured, not this file's job to
      // re-verify at runtime).
      const content = registrar.generateConfig("stdio");
      const parsed = JSON.parse(content);
      expect(parsed.mcpServers["minsky-server"].command).toBe("minsky");
    });
  });

  describe("configPath for claude-code", () => {
    test("returns a user-scope path, ignoring the passed project root", () => {
      const configPath = registrar.configPath("/some-claude-code-project");
      // Should be under the user's home directory, not under the project root
      expect(configPath).not.toContain("/some-claude-code-project");
      expect(configPath.startsWith(os.homedir())).toBe(true);
    });

    test("config path is ~/.claude.json, platform-uniform (no OS branching)", () => {
      const configPath = registrar.configPath("/irrelevant-for-user-scope");
      expect(configPath).toBe(path.join(os.homedir(), ".claude.json"));
    });

    test("configPath resolves to the same file for two different project roots", () => {
      expect(registrar.configPath("/first-claude-code-project")).toBe(
        registrar.configPath("/second-claude-code-project")
      );
    });
  });

  test("claude-code registrar merges rather than overwrites (shares Claude Code's own state file)", () => {
    expect(registrar.mergeConfig).toBe(true);
  });

  test("ClaudeCodeRegistrar extends McpServersJsonRegistrar", () => {
    expect(registrar).toBeInstanceOf(McpServersJsonRegistrar);
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

describe("detectJsonIndent (PR #3423 R1)", () => {
  test("returns 2 as the default when no indent can be matched", () => {
    expect(detectJsonIndent("{}")).toBe(2);
  });

  test("detects a 2-space indented document", () => {
    expect(detectJsonIndent('{\n  "mcpServers": {}\n}')).toBe(2);
  });

  test("detects a 4-space indented document", () => {
    expect(detectJsonIndent('{\n    "mcpServers": {}\n}')).toBe(4);
  });

  test("detects a tab-indented document and returns the tab verbatim (not collapsed to a width)", () => {
    expect(detectJsonIndent('{\n\t"mcpServers": {}\n}')).toBe("\t");
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

  test("returns ClaudeCodeRegistrar for 'claude-code'", () => {
    const r = getRegistrar("claude-code");
    expect(r).toBeInstanceOf(ClaudeCodeRegistrar);
    expect(r.name).toBe("claude-code");
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

  test("throws descriptive error for unsupported client listing all 8 clients", () => {
    expect(() => getRegistrar("unknown")).toThrow(
      'MCP client "unknown" is not yet supported. Supported clients: cursor, claude-desktop, claude-code, vscode, windsurf, junie, codex, openhands'
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

  describe("claude-code config merging (mt#4676)", () => {
    const registrar = new ClaudeCodeRegistrar();

    test("creates new file if config file does not exist, in shim form", async () => {
      await registerWithClient("/any-root", { transport: "stdio" }, "claude-code", mockFs);

      const configPath = registrar.configPath("/any-root");
      expect(mockFs.files.has(configPath)).toBe(true);
      const parsed = JSON.parse(mockFs.files.get(configPath) ?? "");
      expect(parsed.mcpServers["minsky-server"]).toBeDefined();
      expect(parsed.mcpServers["minsky-server"].args).toEqual([
        "mcp",
        "shim",
        "--url",
        "http://127.0.0.1:48765/mcp",
      ]);
    });

    test("merges minsky-server into an existing ~/.claude.json preserving the projects key", async () => {
      // ~/.claude.json carries Claude Code's own state (per-project local-scope
      // entries under `projects`, settings, etc.) -- registering the user-scope
      // entry must not clobber any of it.
      const configPath = registrar.configPath("/any-root");
      const existingConfig = JSON.stringify({
        mcpServers: {
          "other-server": { command: "other", args: ["run"] },
        },
        projects: {
          "/some/other/project": { mcpServers: { "local-scoped-server": { command: "local" } } },
        },
        someOtherKey: "preserved",
      });
      mockFs.files.set(configPath, existingConfig);
      mockFs.directories.add(path.dirname(configPath));

      await registerWithClient("/any-root", { transport: "stdio" }, "claude-code", mockFs);

      const parsed = JSON.parse(mockFs.files.get(configPath) ?? "");
      // Existing user-scope server preserved
      expect(parsed.mcpServers["other-server"]).toBeDefined();
      // Minsky server added at the top-level (user-scope) mcpServers key
      expect(parsed.mcpServers["minsky-server"]).toBeDefined();
      expect(parsed.mcpServers["minsky-server"].command).toBe("minsky");
      // Local-scope (per-project) entries untouched
      expect(parsed.projects["/some/other/project"].mcpServers["local-scoped-server"]).toEqual({
        command: "local",
      });
      // Other top-level keys preserved
      expect(parsed.someOtherKey).toBe("preserved");
    });

    test("overwrites an existing user-scope minsky-server entry when merging, with the shim form regardless of transport/port passed (PR #3423 R2)", async () => {
      const configPath = registrar.configPath("/any-root");
      const existingConfig = JSON.stringify({
        mcpServers: { "minsky-server": { command: "old-command", args: ["old-args"] } },
      });
      mockFs.files.set(configPath, existingConfig);
      mockFs.directories.add(path.dirname(configPath));

      // transport/port are supplied (as a real caller's .minsky/config.yaml
      // mcp section would) to prove they are ignored -- the shim entry does
      // not vary with them.
      await registerWithClient(
        "/any-root",
        { transport: "httpStream", port: 4242 },
        "claude-code",
        mockFs
      );

      const parsed = JSON.parse(mockFs.files.get(configPath) ?? "");
      expect(parsed.mcpServers["minsky-server"].command).toBe("minsky");
      expect(parsed.mcpServers["minsky-server"].args).toEqual([
        "mcp",
        "shim",
        "--url",
        "http://127.0.0.1:48765/mcp",
      ]);
      // The old stdio-spawn entry is gone, not merged with -- overwritten.
      expect(parsed.mcpServers["minsky-server"].args).not.toContain("old-args");
    });

    test("configPath is identical across two different projectRoots (user scope)", async () => {
      await registerWithClient("/project-a", { transport: "stdio" }, "claude-code", mockFs);
      // A second registration from a different project root must resolve to
      // the SAME file -- this is what "user scope" means.
      await registerWithClient("/project-b", { transport: "stdio" }, "claude-code", mockFs, true);

      const configPath = registrar.configPath("/project-a");
      expect(configPath).toBe(registrar.configPath("/project-b"));
      expect(mockFs.files.has(configPath)).toBe(true);
    });

    test("preserves a non-default (4-space) indentation from the existing ~/.claude.json (PR #3423 R1)", async () => {
      // ~/.claude.json is a vendor-owned, operator-live state file -- forcing
      // JSON.stringify's default 2-space indent on every write would reformat
      // the whole file (a surprising diff) regardless of how it was written.
      const configPath = registrar.configPath("/any-root");
      const existingConfig =
        '{\n    "mcpServers": {\n        "other-server": {\n            "command": "other"\n        }\n    }\n}';
      mockFs.files.set(configPath, existingConfig);
      mockFs.directories.add(path.dirname(configPath));

      await registerWithClient("/any-root", { transport: "stdio" }, "claude-code", mockFs);

      const written = mockFs.files.get(configPath) ?? "";
      // 4-space indentation preserved -- NOT collapsed to JSON.stringify's default of 2.
      expect(written).toContain('    "mcpServers"');
      expect(written.startsWith('{\n  "')).toBe(false);
      const parsed = JSON.parse(written);
      expect(parsed.mcpServers["minsky-server"]).toBeDefined();
      expect(parsed.mcpServers["other-server"]).toBeDefined();
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
