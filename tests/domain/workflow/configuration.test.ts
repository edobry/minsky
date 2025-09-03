import { describe, it, expect } from "bun:test";
import {
  parseWorkflowConfig,
  parseWorkflowsConfig,
  generateDefaultWorkflows,
  updateMinskyjsonWithWorkflows,
} from "../../../src/domain/workflow/configuration";

describe("parseWorkflowConfig", () => {
  it("parses simple string configuration", () => {
    const config = parseWorkflowConfig("lint", "eslint");
    
    expect(config.name).toBe("lint");
    expect(config.type).toBe("builtin");
    expect(config.tool).toBe("eslint");
    expect(config.commands.check).toBe("eslint . --format json");
    expect(config.commands.fix).toBe("eslint . --fix");
    expect(config.profile).toBeDefined();
    expect(config.profile?.name).toBe("ESLint");
  });

  it("parses tool with arguments configuration", () => {
    const config = parseWorkflowConfig("lint", {
      tool: "eslint",
      args: "--max-warnings 0"
    });
    
    expect(config.name).toBe("lint");
    expect(config.type).toBe("builtin");
    expect(config.tool).toBe("eslint");
    expect(config.args).toBe("--max-warnings 0");
    expect(config.commands.check).toBe("eslint . --format json --max-warnings 0");
    expect(config.commands.fix).toBe("eslint . --fix --max-warnings 0");
  });

  it("parses custom commands configuration", () => {
    const config = parseWorkflowConfig("security", {
      custom: {
        scan: "custom-scanner --check",
        fix: "custom-scanner --fix"
      }
    });
    
    expect(config.name).toBe("security");
    expect(config.type).toBe("custom");
    expect(config.tool).toBeUndefined();
    expect(config.commands.scan).toBe("custom-scanner --check");
    expect(config.commands.fix).toBe("custom-scanner --fix");
  });

  it("handles unknown tools as custom", () => {
    const config = parseWorkflowConfig("unknown", "unknown-tool");
    
    expect(config.name).toBe("unknown");
    expect(config.type).toBe("custom");
    expect(config.tool).toBe("unknown-tool");
    expect(config.commands).toEqual({});
  });

  it("handles unknown tools with arguments as custom", () => {
    const config = parseWorkflowConfig("unknown", {
      tool: "unknown-tool",
      args: "--custom-arg"
    });
    
    expect(config.name).toBe("unknown");
    expect(config.type).toBe("custom");
    expect(config.tool).toBe("unknown-tool");
    expect(config.args).toBe("--custom-arg");
    expect(config.commands).toEqual({});
  });
});

describe("parseWorkflowsConfig", () => {
  it("parses empty configuration", () => {
    const workflows = parseWorkflowsConfig({});
    expect(workflows).toEqual([]);
  });

  it("parses configuration without workflows section", () => {
    const workflows = parseWorkflowsConfig({
      someOtherSection: "value"
    });
    expect(workflows).toEqual([]);
  });

  it("parses mixed workflow configurations", () => {
    const workflows = parseWorkflowsConfig({
      workflows: {
        lint: "eslint",
        test: {
          tool: "jest",
          args: "--bail"
        },
        security: {
          custom: {
            scan: "gitleaks detect",
            protect: "gitleaks protect"
          }
        }
      }
    });
    
    expect(workflows).toHaveLength(3);
    
    const lint = workflows.find(w => w.name === "lint");
    expect(lint?.type).toBe("builtin");
    expect(lint?.tool).toBe("eslint");
    
    const test = workflows.find(w => w.name === "test");
    expect(test?.type).toBe("builtin");
    expect(test?.tool).toBe("jest");
    expect(test?.args).toBe("--bail");
    
    const security = workflows.find(w => w.name === "security");
    expect(security?.type).toBe("custom");
    expect(security?.commands.scan).toBe("gitleaks detect");
  });

  it("handles invalid configuration gracefully", () => {
    const workflows = parseWorkflowsConfig({
      workflows: "invalid"  // Should be an object
    });
    expect(workflows).toEqual([]);
  });
});

describe("generateDefaultWorkflows", () => {
  it("generates TypeScript project workflows", () => {
    const workflows = generateDefaultWorkflows("typescript");
    
    expect(workflows.lint).toBe("eslint");
    expect(workflows.format).toBe("prettier");
    expect(workflows.typecheck).toBe("tsc");
    expect(workflows.test).toEqual({
      tool: "jest",
      args: "--bail"
    });
    expect(workflows.security).toBe("gitleaks");
  });

  it("generates JavaScript project workflows", () => {
    const workflows = generateDefaultWorkflows("javascript");
    
    expect(workflows.lint).toBe("eslint");
    expect(workflows.format).toBe("prettier");
    expect(workflows.typecheck).toBeUndefined();  // No type checking for JS
    expect(workflows.test).toEqual({
      tool: "jest",
      args: "--bail"
    });
    expect(workflows.security).toBe("gitleaks");
  });

  it("generates Python project workflows", () => {
    const workflows = generateDefaultWorkflows("python");
    
    expect(workflows.lint).toBe("ruff");
    expect(workflows.format).toBe("black");
    expect(workflows.typecheck).toBe("mypy");
    expect(workflows.test).toEqual({
      tool: "pytest",
      args: "--verbose"
    });
    expect(workflows.security).toBeUndefined();  // No default security for Python
  });
});

describe("updateMinskyjsonWithWorkflows", () => {
  it("adds workflows to empty configuration", () => {
    const existingConfig = {};
    const workflows = { lint: "eslint", test: "jest" };
    
    const updated = updateMinskyjsonWithWorkflows(existingConfig, workflows);
    
    expect(updated).toEqual({
      workflows: {
        lint: "eslint",
        test: "jest"
      }
    });
  });

  it("merges workflows with existing configuration", () => {
    const existingConfig = {
      taskBackend: "json-file",
      workflows: {
        lint: "eslint"
      }
    };
    const newWorkflows = {
      test: "jest",
      format: "prettier"
    };
    
    const updated = updateMinskyjsonWithWorkflows(existingConfig, newWorkflows);
    
    expect(updated).toEqual({
      taskBackend: "json-file",
      workflows: {
        lint: "eslint",
        test: "jest", 
        format: "prettier"
      }
    });
  });

  it("overwrites existing workflows with same name", () => {
    const existingConfig = {
      workflows: {
        lint: "eslint",
        test: "jest"
      }
    };
    const newWorkflows = {
      lint: {
        tool: "eslint",
        args: "--max-warnings 0"
      }
    };
    
    const updated = updateMinskyjsonWithWorkflows(existingConfig, newWorkflows);
    
    expect(updated.workflows.lint).toEqual({
      tool: "eslint",
      args: "--max-warnings 0"
    });
    expect(updated.workflows.test).toBe("jest");  // Preserved
  });

  it("preserves other configuration sections", () => {
    const existingConfig = {
      taskBackend: "json-file",
      logger: {
        level: "info"
      },
      workflows: {
        lint: "eslint"
      }
    };
    const newWorkflows = {
      test: "jest"
    };
    
    const updated = updateMinskyjsonWithWorkflows(existingConfig, newWorkflows);
    
    expect(updated.taskBackend).toBe("json-file");
    expect(updated.logger).toEqual({ level: "info" });
    expect(updated.workflows).toEqual({
      lint: "eslint",
      test: "jest"
    });
  });
});

describe("Configuration edge cases", () => {
  it("handles null and undefined values gracefully", () => {
    expect(() => parseWorkflowsConfig(null as any)).not.toThrow();
    expect(() => parseWorkflowsConfig(undefined as any)).not.toThrow();
    
    const nullResult = parseWorkflowsConfig(null as any);
    const undefinedResult = parseWorkflowsConfig(undefined as any);
    
    expect(nullResult).toEqual([]);
    expect(undefinedResult).toEqual([]);
  });

  it("throws for invalid workflow configuration structure", () => {
    expect(() => {
      parseWorkflowConfig("test", { invalid: true } as any);
    }).toThrow();
  });

  it("handles empty workflow objects", () => {
    const workflows = parseWorkflowsConfig({
      workflows: {}
    });
    
    expect(workflows).toEqual([]);
  });
});