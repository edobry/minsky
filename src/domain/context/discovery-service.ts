/**
 * Context Discovery Service
 *
 * Discovers and collects context elements from the current workspace.
 * Handles rules, files, conversation history, and other context sources.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { glob } from "glob";
import type { ContextElement, ContextDiscoveryOptions } from "./types";
import type { Rule } from "../rules/types";
import { log } from "../../utils/logger";

/**
 * Service for discovering context elements in the workspace
 */
export class ContextDiscoveryService {
  /**
   * Discover all context elements based on options
   */
  async discoverContext(options: ContextDiscoveryOptions = {}): Promise<ContextElement[]> {
    const startTime = Date.now();
    const elements: ContextElement[] = [];

    try {
      // Discover rules if requested
      if (options.includeRules !== false) {
        const ruleElements = await this.discoverRules(options);
        elements.push(...ruleElements);
      }

      // Discover files if requested
      if (options.includeFiles !== false) {
        const fileElements = await this.discoverFiles(options);
        elements.push(...fileElements);
      }

      // Discover metadata elements
      const metadataElements = await this.discoverMetadata(options);
      elements.push(...metadataElements);

      const duration = Date.now() - startTime;
      log.debug(`Context discovery completed`, {
        elementsFound: elements.length,
        duration,
        workspacePath: options.workspacePath,
      });

      return elements;
    } catch (error) {
      log.error("Context discovery failed", { error, options });
      throw new Error(`Context discovery failed: ${error}`);
    }
  }

  /**
   * Discover rule files in the workspace
   */
  async discoverRules(options: ContextDiscoveryOptions): Promise<ContextElement[]> {
    const elements: ContextElement[] = [];
    const workspacePath = options.workspacePath || process.cwd();

    try {
      // Look for rule files in common locations
      const rulePatterns = [
        ".cursor/rules/**/*.mdc",
        ".cursor/rules/**/*.md",
        ".cursor/*.mdc",
        ".cursor/*.md",
        "cursor-rules/**/*.mdc",
        "cursor-rules/**/*.md",
        "rules/**/*.mdc",
        "rules/**/*.md",
      ];

      for (const pattern of rulePatterns) {
        const fullPattern = path.join(workspacePath, pattern);
        const files = await glob(fullPattern, {
          ignore: ["**/node_modules/**", "**/.*/**"],
        });

        for (const filePath of files) {
          try {
            const element = await this.createRuleElement(filePath, workspacePath);
            if (element) {
              elements.push(element);
            }
          } catch (error) {
            log.warn(`Failed to process rule file: ${filePath}`, { error });
          }
        }
      }

      log.debug(`Discovered ${elements.length} rule elements`);
      return elements;
    } catch (error) {
      log.error("Failed to discover rules", { error, workspacePath });
      return [];
    }
  }

  /**
   * Discover relevant files in the workspace
   */
  async discoverFiles(options: ContextDiscoveryOptions): Promise<ContextElement[]> {
    const elements: ContextElement[] = [];
    const workspacePath = options.workspacePath || process.cwd();

    try {
      // Default include patterns for common code files
      const defaultPatterns = [
        "src/**/*.ts",
        "src/**/*.js",
        "src/**/*.tsx",
        "src/**/*.jsx",
        "lib/**/*.ts",
        "lib/**/*.js",
        "*.md",
        "*.json",
        "*.yaml",
        "*.yml",
      ];

      const includePatterns = options.includePatterns || defaultPatterns;
      const excludePatterns = options.excludePatterns || [
        "**/node_modules/**",
        "**/dist/**",
        "**/build/**",
        "**/.git/**",
        "**/coverage/**",
        "**/tmp/**",
        "**/temp/**",
      ];

      const maxFileSize = options.maxFileSize || 100 * 1024; // 100KB default
      const maxFiles = options.maxFiles || 50; // Limit to prevent overwhelming context

      let fileCount = 0;

      for (const pattern of includePatterns) {
        if (fileCount >= maxFiles) break;

        const fullPattern = path.join(workspacePath, pattern);
        const files = await glob(fullPattern, {
          ignore: excludePatterns,
        });

        for (const filePath of files) {
          if (fileCount >= maxFiles) break;

          try {
            const stats = await fs.stat(filePath);

            // Skip files that are too large
            if (stats.size > maxFileSize) {
              log.debug(`Skipping large file: ${filePath} (${stats.size} bytes)`);
              continue;
            }

            const element = await this.createFileElement(filePath, workspacePath);
            if (element) {
              elements.push(element);
              fileCount++;
            }
          } catch (error) {
            log.warn(`Failed to process file: ${filePath}`, { error });
          }
        }
      }

      log.debug(`Discovered ${elements.length} file elements`);
      return elements;
    } catch (error) {
      log.error("Failed to discover files", { error, workspacePath });
      return [];
    }
  }

  /**
   * Discover metadata elements (project info, git info, etc.)
   */
  async discoverMetadata(options: ContextDiscoveryOptions): Promise<ContextElement[]> {
    const elements: ContextElement[] = [];
    const workspacePath = options.workspacePath || process.cwd();

    try {
      // Package.json metadata
      const packageJsonPath = path.join(workspacePath, "package.json");
      if (await this.fileExists(packageJsonPath)) {
        const element = await this.createFileElement(packageJsonPath, workspacePath);
        if (element) {
          element.type = "metadata";
          element.name = "Project Configuration (package.json)";
          elements.push(element);
        }
      }

      // README files
      const readmePatterns = ["README.md", "README.txt", "readme.md"];
      for (const readmePattern of readmePatterns) {
        const readmePath = path.join(workspacePath, readmePattern);
        if (await this.fileExists(readmePath)) {
          const element = await this.createFileElement(readmePath, workspacePath);
          if (element) {
            element.type = "metadata";
            element.name = "Project README";
            elements.push(element);
            break; // Only include one README
          }
        }
      }

      log.debug(`Discovered ${elements.length} metadata elements`);
      return elements;
    } catch (error) {
      log.error("Failed to discover metadata", { error, workspacePath });
      return [];
    }
  }

  /**
   * Create a context element from a rule file
   */
  private async createRuleElement(
    filePath: string,
    workspacePath: string
  ): Promise<ContextElement | null> {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const stats = await fs.stat(filePath);
      const relativePath = path.relative(workspacePath, filePath);

      const element: ContextElement = {
        type: "rule",
        id: `rule:${relativePath}`,
        name: path.basename(filePath, path.extname(filePath)),
        content,
        size: {
          characters: content.length,
          lines: content.split("\n").length,
          bytes: stats.size,
        },
        metadata: {
          filePath: relativePath,
          lastModified: stats.mtime,
          contentType: "text/markdown",
        },
      };

      return element;
    } catch (error) {
      log.warn(`Failed to create rule element for ${filePath}`, { error });
      return null;
    }
  }

  /**
   * Create a context element from a regular file
   */
  private async createFileElement(
    filePath: string,
    workspacePath: string
  ): Promise<ContextElement | null> {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const stats = await fs.stat(filePath);
      const relativePath = path.relative(workspacePath, filePath);
      const ext = path.extname(filePath);

      const element: ContextElement = {
        type: "file",
        id: `file:${relativePath}`,
        name: relativePath,
        content,
        size: {
          characters: content.length,
          lines: content.split("\n").length,
          bytes: stats.size,
        },
        metadata: {
          filePath: relativePath,
          lastModified: stats.mtime,
          contentType: this.getContentType(ext),
        },
      };

      return element;
    } catch (error) {
      log.warn(`Failed to create file element for ${filePath}`, { error });
      return null;
    }
  }

  /**
   * Get content type based on file extension
   */
  private getContentType(extension: string): string {
    const typeMap: Record<string, string> = {
      ".ts": "text/typescript",
      ".tsx": "text/typescript",
      ".js": "text/javascript",
      ".jsx": "text/javascript",
      ".md": "text/markdown",
      ".json": "application/json",
      ".yaml": "text/yaml",
      ".yml": "text/yaml",
      ".txt": "text/plain",
    };

    return typeMap[extension.toLowerCase()] || "text/plain";
  }

  /**
   * Check if a file exists
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get workspace type (main or session)
   */
  async getWorkspaceType(workspacePath?: string): Promise<"main" | "session"> {
    const targetPath = workspacePath || process.cwd();

    // Check if this is a Minsky session workspace
    if (targetPath.includes("/.local/state/minsky/sessions/")) {
      return "session";
    }

    return "main";
  }

  /**
   * Get current workspace path
   */
  getCurrentWorkspacePath(): string {
    return process.cwd();
  }
}
