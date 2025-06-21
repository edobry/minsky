/**
 * Backend detector for Minsky configuration system
 *
 * Implements auto-detection of repository characteristics to determine
 * the most appropriate task backend:
 * - process/tasks.md exists → markdown backend
 * - .minsky/tasks.json exists → json-file backend
 * - Always fallback → json-file backend
 */

import { existsSync } from "fs";
import { join } from "path";
import { BackendDetector, DetectionRule } from "./types";

export class DefaultBackendDetector implements BackendDetector {
  /**
   * Detect the most appropriate backend based on detection rules
   */
  async detectBackend(_workingDir: string, rules: DetectionRule[]): Promise<string> {
    for (const rule of rules) {
      const matches = await this.checkCondition(_workingDir, rule.condition);
      if (matches) {
        return rule.backend;
      }
    }

    // Default fallback (should not reach here with proper rules)
    return "json-file";
  }

  /**
   * Check if JSON file exists
   */
  async jsonFileExists(_workingDir: string): Promise<boolean> {
    const jsonFilePath = join(_workingDir, ".minsky", "tasks.json");
    return existsSync(jsonFilePath);
  }

  /**
   * Check if tasks.md file exists
   */
  async tasksMdExists(_workingDir: string): Promise<boolean> {
    const tasksMdPath = join(_workingDir, "process", "tasks.md");
    return existsSync(tasksMdPath);
  }

  /**
   * Check a specific detection condition
   */
  private async checkCondition(
    _workingDir: string,
    condition: "json_file_exists" | "tasks_md_exists" | "always"
  ): Promise<boolean> {
    switch (condition) {
      case "json_file_exists":
        return this.jsonFileExists(_workingDir);
      case "tasks_md_exists":
        return this.tasksMdExists(_workingDir);
      case "always":
        return true;
      default:
        return false;
    }
  }

  // Legacy method - kept for backward compatibility but not used in new detection
  async githubRemoteExists(_workingDir: string): Promise<boolean> {
    return false; // Disabled - GitHub Issues requires explicit configuration
  }
}
