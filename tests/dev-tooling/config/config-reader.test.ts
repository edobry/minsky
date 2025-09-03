import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { join } from "path";
import { createMockFilesystem } from "../../../src/utils/test-utils/filesystem/mock-filesystem";
import {
  ProjectConfigReader,
  type SimplifiedWorkflowConfig,
} from "../../../src/domain/project/config-reader";

// Test constants to avoid magic string duplication
const ESLINT_JSON_COMMAND = "eslint . --format json";

describe("ProjectConfigReader - Dev Tooling", () => {
  let mockFs: ReturnType<typeof createMockFilesystem>;
  let reader: ProjectConfigReader;
  const testDir = "/mock/project";

  beforeEach(() => {
    // Create isolated mock filesystem for each test
    mockFs = createMockFilesystem();

    // Mock filesystem operations
    mock.module("fs", () => ({
      existsSync: mockFs.existsSync,
      readFileSync: mockFs.readFileSync,
      writeFileSync: mockFs.writeFileSync,
      mkdirSync: mockFs.mkdirSync,
      promises: {
        readFile: mockFs.readFile,
        writeFile: mockFs.writeFile,
        mkdir: mockFs.mkdir,
        stat: mockFs.stat,
      },
    }));

    reader = new ProjectConfigReader(testDir);
  });

  afterEach(() => {
    mockFs.cleanup();
  });

  describe("Simplified Config Format (Direct Usage)", () => {
    it("should use simplified format directly without conversion", async () => {
      // Create simplified minsky.json
      const simplifiedConfig = {
        workflows: {
          lint: {
            jsonCommand: ESLINT_JSON_COMMAND,
            fixCommand: "eslint . --fix",
          },
          test: {
            jsonCommand: "bun test --reporter json",
          },
        },
      };

      mockFs.writeFileSync(join(testDir, "minsky.json"), JSON.stringify(simplifiedConfig, null, 2));

      const config = await reader.getConfiguration();

      expect(config.configSource).toBe("minsky.json");
      // Should use simplified format directly - NO CONVERSION!
      expect(config.workflows.lint?.jsonCommand).toBe(ESLINT_JSON_COMMAND);
      expect(config.workflows.lint?.fixCommand).toBe("eslint . --fix");
      expect(config.workflows.test?.jsonCommand).toBe("bun test --reporter json");
    });

    it("should extract commands from simplified format", async () => {
      const config = {
        workflows: {
          lint: {
            jsonCommand: "custom-linter --format json",
            fixCommand: "custom-linter --fix",
          },
          test: {
            jsonCommand: "vitest --reporter json",
          },
        },
      };

      mockFs.writeFileSync(join(testDir, "minsky.json"), JSON.stringify(config, null, 2));

      const lintJsonCommand = await reader.getLintJsonCommand();
      const lintFixCommand = await reader.getLintFixCommand();

      expect(lintJsonCommand).toBe("custom-linter --format json");
      expect(lintFixCommand).toBe("custom-linter --fix");
    });

    it("should handle missing optional commands gracefully", async () => {
      const config = {
        workflows: {
          lint: {
            jsonCommand: ESLINT_JSON_COMMAND,
            // No fixCommand
          },
        },
      };

      mockFs.writeFileSync(join(testDir, "minsky.json"), JSON.stringify(config, null, 2));

      const lintJsonCommand = await reader.getLintJsonCommand();
      const lintFixCommand = await reader.getLintFixCommand();

      expect(lintJsonCommand).toBe(ESLINT_JSON_COMMAND);
      expect(lintFixCommand).toBeUndefined();
    });
  });

  describe("Fallback Detection", () => {
    it("should auto-detect from package.json when minsky.json missing", async () => {
      const packageJson = {
        scripts: {
          lint: "eslint .",
          "lint:fix": "eslint . --fix",
          test: "vitest",
        },
      };

      // Create bun.lock to simulate bun project
      mockFs.writeFileSync(join(testDir, "bun.lock"), "");
      mockFs.writeFileSync(join(testDir, "package.json"), JSON.stringify(packageJson, null, 2));

      const config = await reader.getConfiguration();

      expect(config.configSource).toBe("package.json");
      // Should convert package.json to simplified format
      expect(config.workflows.lint?.jsonCommand).toBe("bun run lint --format json");
      expect(config.workflows.lint?.fixCommand).toBe("bun run lint:fix");
      expect(config.workflows.test?.jsonCommand).toBe("bun run test --reporter json");
    });

    it("should provide defaults when no config found", async () => {
      // Empty mock filesystem - should use defaults
      const config = await reader.getConfiguration();

      expect(config.configSource).toBe("defaults");
      expect(config.workflows.lint?.jsonCommand).toBe(ESLINT_JSON_COMMAND);
      expect(config.workflows.lint?.fixCommand).toBe("eslint . --fix");
      expect(config.runtime.packageManager).toBe("npm");
      expect(config.runtime.language).toBe("javascript");
    });
  });
});
