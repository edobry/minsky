/**
 * Built-in Tool Profiles Library
 *
 * Provides pre-configured tool profiles for common development tools
 * with semantic commands and sensible defaults.
 */

export interface ToolCommand {
  /** The command to execute */
  command: string;
  /** Description of what this command does */
  description?: string;
}

export interface ToolProfile {
  /** Tool name */
  name: string;
  /** Tool description */
  description: string;
  /** Available semantic commands */
  commands: Record<string, ToolCommand>;
  /** Categories this tool belongs to */
  categories: string[];
}

/**
 * Built-in tool profiles for common development tools
 */
export const BUILTIN_TOOLS: Record<string, ToolProfile> = {
  // JavaScript/TypeScript Tools
  eslint: {
    name: "ESLint",
    description: "JavaScript/TypeScript linting tool",
    commands: {
      check: {
        command: "eslint . --format json",
        description: "Check for linting issues",
      },
      fix: {
        command: "eslint . --fix",
        description: "Fix auto-fixable linting issues",
      },
    },
    categories: ["linting", "code-quality"],
  },

  prettier: {
    name: "Prettier",
    description: "Code formatter",
    commands: {
      check: {
        command: "prettier --check .",
        description: "Check code formatting",
      },
      fix: {
        command: "prettier --write .",
        description: "Format code",
      },
    },
    categories: ["formatting", "code-quality"],
  },

  jest: {
    name: "Jest",
    description: "JavaScript testing framework",
    commands: {
      test: {
        command: "jest --json",
        description: "Run tests with JSON output",
      },
      watch: {
        command: "jest --watch",
        description: "Run tests in watch mode",
      },
      coverage: {
        command: "jest --coverage --json",
        description: "Run tests with coverage",
      },
    },
    categories: ["testing"],
  },

  vitest: {
    name: "Vitest",
    description: "Fast unit test framework",
    commands: {
      test: {
        command: "vitest run --reporter=json",
        description: "Run tests with JSON output",
      },
      watch: {
        command: "vitest",
        description: "Run tests in watch mode",
      },
      coverage: {
        command: "vitest run --coverage --reporter=json",
        description: "Run tests with coverage",
      },
    },
    categories: ["testing"],
  },

  bun: {
    name: "Bun Test",
    description: "Bun's built-in test runner",
    commands: {
      test: {
        command: "bun test --reporter json",
        description: "Run tests with JSON output",
      },
      watch: {
        command: "bun test --watch",
        description: "Run tests in watch mode",
      },
    },
    categories: ["testing"],
  },

  // TypeScript
  tsc: {
    name: "TypeScript Compiler",
    description: "TypeScript type checking",
    commands: {
      check: {
        command: "tsc --noEmit",
        description: "Type check without emitting files",
      },
    },
    categories: ["type-checking", "code-quality"],
  },

  // Python Tools
  ruff: {
    name: "Ruff",
    description: "Fast Python linter",
    commands: {
      check: {
        command: "ruff check --format json",
        description: "Check for linting issues",
      },
      fix: {
        command: "ruff check --fix",
        description: "Fix auto-fixable issues",
      },
    },
    categories: ["linting", "code-quality"],
  },

  black: {
    name: "Black",
    description: "Python code formatter",
    commands: {
      check: {
        command: "black --check .",
        description: "Check code formatting",
      },
      fix: {
        command: "black .",
        description: "Format code",
      },
    },
    categories: ["formatting", "code-quality"],
  },

  pytest: {
    name: "pytest",
    description: "Python testing framework",
    commands: {
      test: {
        command: "pytest --json-report --json-report-file=/dev/stdout",
        description: "Run tests with JSON output",
      },
      watch: {
        command: "pytest-watch",
        description: "Run tests in watch mode",
      },
      coverage: {
        command: "pytest --cov --cov-report=json",
        description: "Run tests with coverage",
      },
    },
    categories: ["testing"],
  },

  mypy: {
    name: "mypy",
    description: "Python type checker",
    commands: {
      check: {
        command: "mypy --json-output /dev/stdout",
        description: "Type check Python code",
      },
    },
    categories: ["type-checking", "code-quality"],
  },

  // Security Tools
  gitleaks: {
    name: "Gitleaks",
    description: "Secret scanner",
    commands: {
      scan: {
        command: "gitleaks detect --format json",
        description: "Scan for secrets",
      },
      protect: {
        command: "gitleaks protect --staged",
        description: "Protect against committing secrets",
      },
    },
    categories: ["security"],
  },

  // Dependency Management
  npm: {
    name: "npm",
    description: "Node.js package manager",
    commands: {
      audit: {
        command: "npm audit --json",
        description: "Audit dependencies for vulnerabilities",
      },
      outdated: {
        command: "npm outdated --json",
        description: "Check for outdated packages",
      },
    },
    categories: ["dependency-management"],
  },

  yarn: {
    name: "Yarn",
    description: "JavaScript package manager",
    commands: {
      audit: {
        command: "yarn audit --json",
        description: "Audit dependencies",
      },
      outdated: {
        command: "yarn outdated --json",
        description: "Check for outdated packages",
      },
    },
    categories: ["dependency-management"],
  },
};

/**
 * Get available tools by category
 */
export function getToolsByCategory(category: string): ToolProfile[] {
  return Object.values(BUILTIN_TOOLS).filter((tool) => tool.categories.includes(category));
}

/**
 * Get all available tool categories
 */
export function getAllCategories(): string[] {
  const categories = new Set<string>();
  Object.values(BUILTIN_TOOLS).forEach((tool) => {
    tool.categories.forEach((cat) => categories.add(cat));
  });
  return Array.from(categories).sort();
}

/**
 * Check if a tool is available in the built-in library
 */
export function hasBuiltinTool(toolName: string): boolean {
  return toolName in BUILTIN_TOOLS;
}

/**
 * Get a built-in tool profile
 */
export function getBuiltinTool(toolName: string): ToolProfile | undefined {
  return BUILTIN_TOOLS[toolName];
}
