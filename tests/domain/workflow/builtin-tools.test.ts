import { describe, it, expect } from "bun:test";
import {
  BUILTIN_TOOLS,
  getToolsByCategory,
  getAllCategories,
  hasBuiltinTool,
  getBuiltinTool,
} from "../../../src/domain/workflow/builtin-tools";

describe("BUILTIN_TOOLS", () => {
  it("contains expected JavaScript/TypeScript tools", () => {
    expect(BUILTIN_TOOLS.eslint).toBeDefined();
    expect(BUILTIN_TOOLS.prettier).toBeDefined();
    expect(BUILTIN_TOOLS.jest).toBeDefined();
    expect(BUILTIN_TOOLS.vitest).toBeDefined();
    expect(BUILTIN_TOOLS.tsc).toBeDefined();
    expect(BUILTIN_TOOLS.bun).toBeDefined();
  });

  it("contains expected Python tools", () => {
    expect(BUILTIN_TOOLS.ruff).toBeDefined();
    expect(BUILTIN_TOOLS.black).toBeDefined();
    expect(BUILTIN_TOOLS.pytest).toBeDefined();
    expect(BUILTIN_TOOLS.mypy).toBeDefined();
  });

  it("contains expected security and dependency tools", () => {
    expect(BUILTIN_TOOLS.gitleaks).toBeDefined();
    expect(BUILTIN_TOOLS.npm).toBeDefined();
    expect(BUILTIN_TOOLS.yarn).toBeDefined();
  });

  it("has properly structured tool profiles", () => {
    const eslint = BUILTIN_TOOLS.eslint;

    expect(eslint.name).toBe("ESLint");
    expect(eslint.description).toBe("JavaScript/TypeScript linting tool");
    expect(eslint.categories).toEqual(["linting", "code-quality"]);
    expect(eslint.commands).toBeDefined();
    expect(eslint.commands.check).toBeDefined();
    expect(eslint.commands.fix).toBeDefined();

    // Check command structure
    expect(eslint.commands.check.command).toBe("eslint . --format json");
    expect(eslint.commands.check.description).toBe("Check for linting issues");
    expect(eslint.commands.fix.command).toBe("eslint . --fix");
    expect(eslint.commands.fix.description).toBe("Fix auto-fixable linting issues");
  });
});

describe("getToolsByCategory", () => {
  it("returns tools in the linting category", () => {
    const lintingTools = getToolsByCategory("linting");

    expect(lintingTools).toContainEqual(
      expect.objectContaining({
        name: "ESLint",
        categories: expect.arrayContaining(["linting"]),
      })
    );

    expect(lintingTools).toContainEqual(
      expect.objectContaining({
        name: "Ruff",
        categories: expect.arrayContaining(["linting"]),
      })
    );
  });

  it("returns tools in the testing category", () => {
    const testingTools = getToolsByCategory("testing");

    const toolNames = testingTools.map((tool) => tool.name);
    expect(toolNames).toContain("Jest");
    expect(toolNames).toContain("Vitest");
    expect(toolNames).toContain("Bun Test");
    expect(toolNames).toContain("pytest");
  });

  it("returns empty array for non-existent category", () => {
    const nonExistentTools = getToolsByCategory("non-existent");
    expect(nonExistentTools).toEqual([]);
  });

  it("returns tools that have multiple categories correctly", () => {
    const codeQualityTools = getToolsByCategory("code-quality");

    // ESLint should be in both linting and code-quality
    expect(codeQualityTools.some((tool) => tool.name === "ESLint")).toBe(true);

    const eslint = codeQualityTools.find((tool) => tool.name === "ESLint");
    expect(eslint?.categories).toContain("linting");
    expect(eslint?.categories).toContain("code-quality");
  });
});

describe("getAllCategories", () => {
  it("returns all unique categories from all tools", () => {
    const categories = getAllCategories();

    expect(categories).toContain("linting");
    expect(categories).toContain("formatting");
    expect(categories).toContain("testing");
    expect(categories).toContain("type-checking");
    expect(categories).toContain("code-quality");
    expect(categories).toContain("security");
    expect(categories).toContain("dependency-management");
  });

  it("returns categories in sorted order", () => {
    const categories = getAllCategories();

    const sorted = [...categories].sort();
    expect(categories).toEqual(sorted);
  });

  it("returns unique categories (no duplicates)", () => {
    const categories = getAllCategories();

    const unique = [...new Set(categories)];
    expect(categories).toEqual(unique);
  });
});

describe("hasBuiltinTool", () => {
  it("returns true for existing tools", () => {
    expect(hasBuiltinTool("eslint")).toBe(true);
    expect(hasBuiltinTool("prettier")).toBe(true);
    expect(hasBuiltinTool("jest")).toBe(true);
    expect(hasBuiltinTool("gitleaks")).toBe(true);
  });

  it("returns false for non-existent tools", () => {
    expect(hasBuiltinTool("non-existent")).toBe(false);
    expect(hasBuiltinTool("webpack")).toBe(false);
    expect(hasBuiltinTool("")).toBe(false);
  });

  it("is case sensitive", () => {
    expect(hasBuiltinTool("ESLint")).toBe(false); // should be "eslint"
    expect(hasBuiltinTool("JEST")).toBe(false); // should be "jest"
  });
});

describe("getBuiltinTool", () => {
  it("returns the correct tool profile for existing tools", () => {
    const eslint = getBuiltinTool("eslint");

    expect(eslint).toBeDefined();
    expect(eslint?.name).toBe("ESLint");
    expect(eslint?.description).toBe("JavaScript/TypeScript linting tool");
    expect(eslint?.categories).toEqual(["linting", "code-quality"]);
  });

  it("returns undefined for non-existent tools", () => {
    expect(getBuiltinTool("non-existent")).toBeUndefined();
    expect(getBuiltinTool("")).toBeUndefined();
  });

  it("returns complete tool profile with all commands", () => {
    const jest = getBuiltinTool("jest");

    expect(jest).toBeDefined();
    expect(jest?.commands.test).toBeDefined();
    expect(jest?.commands.watch).toBeDefined();
    expect(jest?.commands.coverage).toBeDefined();

    expect(jest?.commands.test.command).toBe("jest --json");
    expect(jest?.commands.watch.command).toBe("jest --watch");
    expect(jest?.commands.coverage.command).toBe("jest --coverage --json");
  });

  it("returns tools with correct category associations", () => {
    const gitleaks = getBuiltinTool("gitleaks");
    expect(gitleaks?.categories).toEqual(["security"]);

    const npm = getBuiltinTool("npm");
    expect(npm?.categories).toEqual(["dependency-management"]);

    const tsc = getBuiltinTool("tsc");
    expect(tsc?.categories).toEqual(["type-checking", "code-quality"]);
  });
});

describe("Tool command consistency", () => {
  it("ensures all tools have consistent command structure", () => {
    Object.entries(BUILTIN_TOOLS).forEach(([toolName, tool]) => {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(Array.isArray(tool.categories)).toBe(true);
      expect(tool.categories.length).toBeGreaterThan(0);
      expect(typeof tool.commands).toBe("object");
      expect(Object.keys(tool.commands).length).toBeGreaterThan(0);

      Object.entries(tool.commands).forEach(([commandName, command]) => {
        expect(command.command).toBeTruthy();
        expect(typeof command.command).toBe("string");
        // Description is optional but should be string if present
        if (command.description) {
          expect(typeof command.description).toBe("string");
        }
      });
    });
  });

  it("ensures linting tools have check and fix commands", () => {
    const lintingTools = getToolsByCategory("linting");

    lintingTools.forEach((tool) => {
      expect(tool.commands.check).toBeDefined();
      expect(tool.commands.fix).toBeDefined();
    });
  });

  it("ensures testing tools have test command", () => {
    const testingTools = getToolsByCategory("testing");

    testingTools.forEach((tool) => {
      expect(tool.commands.test).toBeDefined();
    });
  });

  it("ensures formatting tools have check and fix commands", () => {
    const formattingTools = getToolsByCategory("formatting");

    formattingTools.forEach((tool) => {
      expect(tool.commands.check).toBeDefined();
      expect(tool.commands.fix).toBeDefined();
    });
  });
});
