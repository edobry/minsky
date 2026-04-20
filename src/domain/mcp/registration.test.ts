/**
 * Tests for MCP client registration module.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import * as path from "path";
import { CursorRegistrar, getRegistrar, registerWithClient } from "./registration";
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
});

describe("getRegistrar", () => {
  test("returns CursorRegistrar for 'cursor'", () => {
    const r = getRegistrar("cursor");
    expect(r).toBeInstanceOf(CursorRegistrar);
    expect(r.name).toBe("cursor");
  });

  test("throws descriptive error for unsupported client", () => {
    expect(() => getRegistrar("unknown")).toThrow(
      'MCP client "unknown" is not yet supported. Supported clients: cursor'
    );
  });

  test("throws descriptive error for 'claude-desktop'", () => {
    expect(() => getRegistrar("claude-desktop")).toThrow(
      'MCP client "claude-desktop" is not yet supported. Supported clients: cursor'
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

    const content = mockFs.files.get(path.join("/my-project", ".cursor", "mcp.json"))!;
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

    const content = mockFs.files.get(path.join("/my-project", ".cursor", "mcp.json"))!;
    const parsed = JSON.parse(content);
    expect(parsed.mcpServers["minsky-server"].args).toContain("--sse");
  });
});
