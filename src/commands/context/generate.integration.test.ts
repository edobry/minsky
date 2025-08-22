import { describe, it, expect } from "bun:test";
import { execSync } from "child_process";

describe("context generate integration", () => {
  const CLI_PATH = "./src/cli.ts";

  describe("XML/JSON format integration", () => {
    it.skip("should generate JSON format by default", () => {
      const result = execSync(
        `bun run ${CLI_PATH} context generate --components tool-schemas 2>/dev/null`,
        { encoding: "utf-8", cwd: process.cwd() }
      );

      expect(result).toInclude("Here are the functions available in JSONSchema format:");
      expect(result).toInclude('{"tasks.list":');
      expect(result).not.toInclude("<functions>");
      expect(result).toInclude("Interface: cli");
    });

    it.skip("should generate XML format with --interface mcp", () => {
      const result = execSync(
        `bun run ${CLI_PATH} context generate --components tool-schemas --interface mcp 2>/dev/null`,
        { encoding: "utf-8", cwd: process.cwd() }
      );

      expect(result).toInclude("Here are the functions available in JSONSchema format:");
      expect(result).toInclude("<functions>");
      expect(result).toInclude("<function>");
      expect(result).toInclude('"name": "tasks.list"');
      expect(result).toInclude("Interface: mcp");
    });

    it.skip("should generate JSON format with --interface hybrid", () => {
      const result = execSync(
        `bun run ${CLI_PATH} context generate --components tool-schemas --interface hybrid 2>/dev/null`,
        { encoding: "utf-8", cwd: process.cwd() }
      );

      expect(result).toInclude("Here are the functions available in JSONSchema format:");
      expect(result).toInclude('{"tasks.list":');
      expect(result).not.toInclude("<functions>");
      expect(result).toInclude("Interface: hybrid");
    });

    it.skip("should generate valid JSON output with --format json", () => {
      const result = execSync(
        `bun run ${CLI_PATH} context generate --components tool-schemas --format json 2>/dev/null`,
        { encoding: "utf-8", cwd: process.cwd() }
      );

      const jsonOutput = JSON.parse(result);
      expect(jsonOutput).toHaveProperty("sections");
      expect(jsonOutput).toHaveProperty("metadata");
      expect(jsonOutput.sections).toBeArray();
      expect(jsonOutput.sections.length).toBeGreaterThan(0);
      expect(jsonOutput.sections[0]).toHaveProperty("component_id", "tool-schemas");
      expect(jsonOutput.sections[0]).toHaveProperty("content");
    });
  });

  describe("component functionality", () => {
    it.skip("should support multiple components", () => {
      const result = execSync(
        `bun run ${CLI_PATH} context generate --components environment,tool-schemas 2>/dev/null`,
        { encoding: "utf-8", cwd: process.cwd() }
      );

      expect(result).toInclude("Components: environment, tool-schemas");
      expect(result).toInclude("## Environment Setup");
      expect(result).toInclude("Here are the functions available in JSONSchema format:");
    });

    it.skip("should include interface information in output", () => {
      const result = execSync(
        `bun run ${CLI_PATH} context generate --components environment --interface mcp 2>/dev/null`,
        { encoding: "utf-8", cwd: process.cwd() }
      );

      expect(result).toInclude("Interface: mcp");
      expect(result).toInclude("Target Model: gpt-4o");
    });
  });

  describe("error handling", () => {
    it.skip("should handle unknown components gracefully", () => {
      try {
        execSync(
          `bun run ${CLI_PATH} context generate --components unknown-component 2>/dev/null`,
          { encoding: "utf-8", cwd: process.cwd() }
        );
        // Should not reach here
        expect(true).toBe(false);
      } catch (error: any) {
        expect(error.status).toBe(1);
      }
    });
  });
});
