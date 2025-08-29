/**
 * Project Configuration Reader
 *
 * Detects and loads project-specific workflow configurations from various sources.
 * Supports runtime-independent configuration for linting and other development commands.
 */

import { readFileSync, existsSync } from "fs";
import { resolve, join } from "path";

export interface ProjectWorkflowConfig {
  lint?: string;
  lintFix?: string;
  lintJson?: string;
  test?: string;
  build?: string;
  dev?: string;
  start?: string;
}

export interface ProjectRuntimeConfig {
  packageManager?: "npm" | "yarn" | "pnpm" | "bun";
  language?: "typescript" | "javascript" | "rust" | "go" | "python" | "other";
}

export interface ProjectConfiguration {
  workflows: ProjectWorkflowConfig;
  runtime: ProjectRuntimeConfig;
  configSource: "minsky.json" | "package.json" | "auto-detected" | "defaults";
}

/**
 * Project configuration reader with automatic detection
 */
export class ProjectConfigReader {
  constructor(private projectRoot: string = process.cwd()) {}

  /**
   * Get the complete project configuration with automatic detection
   */
  async getConfiguration(): Promise<ProjectConfiguration> {
    // 1. Try explicit minsky configuration
    const minskyConfig = this.loadMinskyConfig();
    if (minskyConfig) {
      return {
        ...minskyConfig,
        configSource: "minsky.json",
      };
    }

    // 2. Try package.json detection
    const packageConfig = this.detectFromPackageJson();
    if (packageConfig) {
      return {
        ...packageConfig,
        configSource: "package.json",
      };
    }

    // 3. Language-specific auto-detection
    const autoConfig = this.autoDetectFromLanguage();
    if (autoConfig) {
      return {
        ...autoConfig,
        configSource: "auto-detected",
      };
    }

    // 4. Fallback to defaults
    return this.getDefaultConfiguration();
  }

  /**
   * Get the lint command for the current project
   */
  async getLintCommand(): Promise<string> {
    const config = await this.getConfiguration();
    return config.workflows.lint || "eslint .";
  }

  /**
   * Get the lint command that outputs JSON format
   */
  async getLintJsonCommand(): Promise<string> {
    const config = await this.getConfiguration();
    
    if (config.workflows.lintJson) {
      return config.workflows.lintJson;
    }
    
    // Build JSON command from base lint command
    const baseLintCommand = config.workflows.lint || "eslint .";
    
    // Handle different package managers
    if (baseLintCommand.includes(" run ")) {
      // Package manager command - append format after the script name
      return baseLintCommand.replace(" run lint", " run lint -- --format json");
    }
    
    // Direct command - append format flag
    return `${baseLintCommand} --format json`;
  }

  /**
   * Load explicit minsky configuration
   */
  private loadMinskyConfig(): { workflows: ProjectWorkflowConfig; runtime: ProjectRuntimeConfig } | null {
    const possiblePaths = [
      join(this.projectRoot, "minsky.json"),
      join(this.projectRoot, ".minsky", "config.json"),
      join(this.projectRoot, "config", "minsky.json"),
    ];

    for (const configPath of possiblePaths) {
      if (existsSync(configPath)) {
        try {
          const config = JSON.parse(readFileSync(configPath, "utf8"));
          if (config.workflows) {
            return {
              workflows: config.workflows,
              runtime: config.runtime || {},
            };
          }
        } catch (error) {
          // Continue to next file
          console.warn(`Warning: Failed to parse ${configPath}:`, error);
        }
      }
    }

    return null;
  }

  /**
   * Detect configuration from package.json scripts
   */
  private detectFromPackageJson(): { workflows: ProjectWorkflowConfig; runtime: ProjectRuntimeConfig } | null {
    const packageJsonPath = join(this.projectRoot, "package.json");
    
    if (!existsSync(packageJsonPath)) {
      return null;
    }

    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      const scripts = packageJson.scripts || {};
      
      // Detect package manager from lockfiles and dependencies
      const packageManager = this.detectPackageManager();
      const language = this.detectLanguageFromPackageJson(packageJson);

      const workflows: ProjectWorkflowConfig = {};

      // Build commands based on available scripts
      if (scripts.lint) {
        workflows.lint = `${packageManager} run lint`;
        workflows.lintJson = `${packageManager} run lint -- --format json`;
      }
      
      if (scripts["lint:fix"]) {
        workflows.lintFix = `${packageManager} run lint:fix`;
      }
      
      if (scripts.test) {
        workflows.test = `${packageManager} run test`;
      }
      
      if (scripts.build) {
        workflows.build = `${packageManager} run build`;
      }
      
      if (scripts.dev) {
        workflows.dev = `${packageManager} run dev`;
      }
      
      if (scripts.start) {
        workflows.start = `${packageManager} run start`;
      }

      // Only return if we found at least a lint command
      if (workflows.lint) {
        return {
          workflows,
          runtime: { packageManager, language },
        };
      }
    } catch (error) {
      console.warn(`Warning: Failed to parse package.json:`, error);
    }

    return null;
  }

  /**
   * Auto-detect configuration based on project language/structure
   */
  private autoDetectFromLanguage(): { workflows: ProjectWorkflowConfig; runtime: ProjectRuntimeConfig } | null {
    const workflows: ProjectWorkflowConfig = {};
    const runtime: ProjectRuntimeConfig = {};

    // Rust detection
    if (existsSync(join(this.projectRoot, "Cargo.toml"))) {
      runtime.language = "rust";
      workflows.lint = "cargo clippy";
      workflows.lintJson = "cargo clippy --message-format=json";
      workflows.test = "cargo test";
      workflows.build = "cargo build";
      return { workflows, runtime };
    }

    // Go detection
    if (existsSync(join(this.projectRoot, "go.mod"))) {
      runtime.language = "go";
      workflows.lint = "golangci-lint run";
      workflows.lintJson = "golangci-lint run --out-format=json";
      workflows.test = "go test ./...";
      workflows.build = "go build";
      return { workflows, runtime };
    }

    // Python detection
    if (existsSync(join(this.projectRoot, "pyproject.toml")) || 
        existsSync(join(this.projectRoot, "requirements.txt")) ||
        existsSync(join(this.projectRoot, "setup.py"))) {
      runtime.language = "python";
      workflows.lint = "flake8";
      workflows.lintJson = "flake8 --format=json";
      workflows.test = "pytest";
      return { workflows, runtime };
    }

    return null;
  }

  /**
   * Get default configuration
   */
  private getDefaultConfiguration(): ProjectConfiguration {
    return {
      workflows: {
        lint: "eslint .",
        lintJson: "eslint . --format json",
        lintFix: "eslint . --fix",
        test: "npm test",
      },
      runtime: {
        packageManager: "npm",
        language: "javascript",
      },
      configSource: "defaults",
    };
  }

  /**
   * Detect package manager from lockfiles
   */
  private detectPackageManager(): "npm" | "yarn" | "pnpm" | "bun" {
    if (existsSync(join(this.projectRoot, "bun.lockb")) || existsSync(join(this.projectRoot, "bun.lock"))) return "bun";
    if (existsSync(join(this.projectRoot, "pnpm-lock.yaml"))) return "pnpm";
    if (existsSync(join(this.projectRoot, "yarn.lock"))) return "yarn";
    return "npm"; // default
  }

  /**
   * Detect language from package.json
   */
  private detectLanguageFromPackageJson(packageJson: any): "typescript" | "javascript" | "other" {
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
    
    if (deps.typescript || deps["@types/node"] || existsSync(join(this.projectRoot, "tsconfig.json"))) {
      return "typescript";
    }
    
    return "javascript";
  }

  /**
   * Find project root by looking for common indicators
   */
  static findProjectRoot(startDir: string = process.cwd()): string | null {
    let currentDir = resolve(startDir);
    const root = resolve("/");

    while (currentDir !== root) {
      // Check for common project indicators
      const indicators = [
        "package.json",
        "Cargo.toml", 
        "go.mod",
        "pyproject.toml",
        ".git",
        "minsky.json",
        ".minsky",
      ];

      if (indicators.some(indicator => existsSync(join(currentDir, indicator)))) {
        return currentDir;
      }

      currentDir = resolve(currentDir, "..");
    }

    return null;
  }
}
