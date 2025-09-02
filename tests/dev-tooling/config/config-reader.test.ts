import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { join } from "path";
import { createMockFilesystem } from "../../../src/utils/test-utils/filesystem/mock-filesystem";
import { ProjectConfigReader } from "../../../src/domain/project/config-reader";

describe("ProjectConfigReader - Dev Tooling", () => {
  let mockFs: ReturnType<typeof createMockFilesystem>;
  let reader: ProjectConfigReader;
  const testDir = "/mock/project";

  beforeEach(() => {
    mockFs = createMockFilesystem();

    // Mock filesystem operations
    mock.module("fs", () => ({
      existsSync: mockFs.existsSync,
      readFileSync: mockFs.readFileSync,
      writeFileSync: mockFs.writeFileSync,
    }));

    reader = new ProjectConfigReader(testDir);
  });

  afterEach(() => {
    mockFs.cleanup();
  });

  describe("Simplified Config Format (Direct Usage)", () => {
    test("should load simplified minsky.json format directly", async () => {
      const config = {
        workflows: {
          lint: {
            jsonCommand: "eslint . --format json",
            fixCommand: "eslint . --fix",
          },
          test: {
            jsonCommand: "bun test --reporter json",
          },
        },
      };

      mockFs.writeFileSync(join(testDir, "minsky.json"), JSON.stringify(config, null, 2));

      const result = await reader.getConfiguration();

      expect(result.workflows.lint?.jsonCommand).toBe("eslint . --format json");
      expect(result.workflows.lint?.fixCommand).toBe("eslint . --fix");
      expect(result.workflows.test?.jsonCommand).toBe("bun test --reporter json");
      expect(result.configSource).toBe("minsky.json");
    });

    test("should extract commands from simplified format", async () => {
      const config = {
        workflows: {
          lint: {
            jsonCommand: "eslint . --format json",
            fixCommand: "eslint . --fix",
          },
        },
      };

      mockFs.writeFileSync(join(testDir, "minsky.json"), JSON.stringify(config, null, 2));

      const lintJsonCommand = await reader.getLintJsonCommand();
      const lintFixCommand = await reader.getLintFixCommand();

      expect(lintJsonCommand).toBe("eslint . --format json");
      expect(lintFixCommand).toBe("eslint . --fix");
    });

    test("should handle missing optional commands gracefully", async () => {
      const config = {
        workflows: {
          lint: {
            jsonCommand: "eslint . --format json",
            // No fixCommand
          },
        },
      };

      mockFs.writeFileSync(join(testDir, "minsky.json"), JSON.stringify(config, null, 2));

      const lintJsonCommand = await reader.getLintJsonCommand();
      const lintFixCommand = await reader.getLintFixCommand();

      expect(lintJsonCommand).toBe("eslint . --format json");
      expect(lintFixCommand).toBeUndefined();
    });
  });

  describe("Error Handling", () => {
    test("should throw error when minsky.json missing", async () => {
      await expect(reader.getConfiguration()).rejects.toThrow("minsky.json not found");
    });

    test("should throw error when minsky.json is invalid JSON", async () => {
      mockFs.writeFileSync(join(testDir, "minsky.json"), "{ invalid json }");

      await expect(reader.getConfiguration()).rejects.toThrow("Invalid minsky.json format");
    });

    test("should handle empty workflows gracefully", async () => {
      const config = { workflows: {} };
      mockFs.writeFileSync(join(testDir, "minsky.json"), JSON.stringify(config, null, 2));

      const result = await reader.getConfiguration();
      expect(result.workflows).toEqual({});
      expect(result.configSource).toBe("minsky.json");
    });
  });
});
