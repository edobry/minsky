import { describe, it, expect } from "bun:test";
import { execSync } from "child_process";
import { CLI_COMMANDS, TEST_PATHS } from "../../utils/test-utils/test-constants";

describe.skip("context generate integration", () => {
  const CLI_PATH = "./src/cli.ts";

  describe("XML/JSON format integration", () => {
    it("should generate JSON format by default", () => {
      const result = execSync(
        `bun run ${CLI_PATH} context generate --components tool-schemas 2>/dev/null`,
        { encoding: "utf-8", cwd: TEST_PATHS.MOCK_WORKSPACE }
      );

      expect(result).toInclude(CLI_COMMANDS.JSONSCHEMA_FUNCTIONS_AVAILABLE);
      expect(result).toInclude('"tasks.list": {');
      expect(result).not.toInclude("<functions>");
      expect(result).toInclude("Interface: cli");
    });

    it("should generate XML format with --interface mcp", () => {
      const result = execSync(
        `bun run ${CLI_PATH} context generate --components tool-schemas --interface mcp 2>/dev/null`,
        { encoding: "utf-8", cwd: TEST_PATHS.MOCK_WORKSPACE }
      );

      expect(result).toInclude(CLI_COMMANDS.JSONSCHEMA_FUNCTIONS_AVAILABLE);
      expect(result).toInclude("<functions>");
      expect(result).toInclude("<function>");
      expect(result).toInclude('"name": "tasks.list"');
      expect(result).toInclude("Interface: mcp");
    });

    it("should generate JSON format with --interface hybrid", () => {
      const result = execSync(
        `bun run ${CLI_PATH} context generate --components tool-schemas --interface hybrid 2>/dev/null`,
        { encoding: "utf-8", cwd: TEST_PATHS.MOCK_WORKSPACE }
      );

      expect(result).toInclude(CLI_COMMANDS.JSONSCHEMA_FUNCTIONS_AVAILABLE);
      expect(result).toInclude('"tasks.list": {');
      expect(result).not.toInclude("<functions>");
      expect(result).toInclude("Interface: hybrid");
    });

    it("should generate valid JSON output with --format json", () => {
      const result = execSync(
        `bun run ${CLI_PATH} context generate --components tool-schemas --format json 2>/dev/null`,
        { encoding: "utf-8", cwd: TEST_PATHS.MOCK_WORKSPACE }
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
    it("should support multiple components", () => {
      const result = execSync(
        `bun run ${CLI_PATH} context generate --components environment,tool-schemas 2>/dev/null`,
        { encoding: "utf-8", cwd: TEST_PATHS.MOCK_WORKSPACE }
      );

      expect(result).toInclude("Components: environment, tool-schemas");
      expect(result).toInclude("## Environment Setup");
      expect(result).toInclude(CLI_COMMANDS.JSONSCHEMA_FUNCTIONS_AVAILABLE);
    });

    it("should include interface information in output", () => {
      const result = execSync(
        `bun run ${CLI_PATH} context generate --components environment --interface mcp 2>/dev/null`,
        { encoding: "utf-8", cwd: TEST_PATHS.MOCK_WORKSPACE }
      );

      expect(result).toInclude("Interface: mcp");
      expect(result).toInclude("Target Model: gpt-4o");
    });
  });

  describe("error handling", () => {
    it("should handle unknown components gracefully", () => {
      try {
        execSync(
          `bun run ${CLI_PATH} context generate --components unknown-component 2>/dev/null`,
          { encoding: "utf-8", cwd: TEST_PATHS.MOCK_WORKSPACE }
        );
        // Should not reach here
        expect(true).toBe(false);
      } catch (error: any) {
        expect(error.status).toBe(1);
      }
    });
  });
});
