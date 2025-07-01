/**
 * Backend Detection for Task Systems
 * 
 * Provides automatic detection of appropriate task backends based on
 * what files exist in the workspace, integrated with node-config.
 */

import { existsSync } from "fs";
import { join } from "path";
import config from "config";
import { log } from "../../utils/logger";

export interface DetectionRule {
  condition: "json_file_exists" | "tasks_md_exists" | "always";
  backend: string;
}

/**
 * Detect the appropriate backend for a workspace based on existing files
 * and configured detection rules
 * @param workspacePath Path to the workspace to analyze
 * @returns Promise resolving to the detected backend name
 */
export async function detectBackend(workspacePath: string): Promise<string> {
  try {
    // Get detection rules from node-config
    const detectionRules = config.get("detectionRules") as DetectionRule[];
    const defaultBackend = config.get("backend") as string;

    log.debug(`Starting backend detection for ${workspacePath}`);

    // Apply detection rules in order
    for (const rule of detectionRules) {
      if (await evaluateCondition(rule.condition, workspacePath)) {
        log.debug(`Backend detected via rule ${rule.condition}: ${rule.backend}`);
        return rule.backend;
      }
    }

    // Fallback to configured default
    log.debug(`No detection rule matched, using default backend: ${defaultBackend}`);
    return defaultBackend;
  } catch (error) {
    const fallback = "json-file";
    log.warn(`Backend detection failed for ${workspacePath}, using fallback: ${fallback}`);
    return fallback;
  }
}

/**
 * Evaluate a detection condition against a workspace
 * @param condition The condition to evaluate
 * @param workspacePath Path to the workspace
 * @returns Promise resolving to true if condition is met
 */
async function evaluateCondition(
  condition: DetectionRule["condition"],
  workspacePath: string
): Promise<boolean> {
  switch (condition) {
  case "tasks_md_exists":
    return tasksMdExists(workspacePath);
  case "json_file_exists":
    return jsonFileExists(workspacePath);
  case "always":
    return true;
  default:
    log.warn(`Unknown detection condition: ${condition}`);
    return false;
  }
}

/**
 * Check if a tasks.md file exists in the workspace
 * @param workspacePath Path to the workspace
 * @returns True if tasks.md exists
 */
function tasksMdExists(workspacePath: string): boolean {
  const tasksPath = join(workspacePath, "tasks.md");
  return existsSync(tasksPath);
}

/**
 * Check if JSON task files exist in the workspace
 * @param workspacePath Path to the workspace  
 * @returns True if JSON task files are found
 */
function jsonFileExists(workspacePath: string): boolean {
  // Check for common JSON task file locations
  const possiblePaths = [
    join(workspacePath, "tasks.json"),
    join(workspacePath, ".minsky", "tasks.json"),
    join(workspacePath, "process", "tasks.json"),
  ];

  return possiblePaths.some(path => existsSync(path));
}

/**
 * Check if a GitHub remote exists (for potential GitHub Issues backend)
 * @param workspacePath Path to the workspace
 * @returns Promise resolving to true if GitHub remote exists
 */
export async function githubRemoteExists(workspacePath: string): Promise<boolean> {
  try {
    const { execSync } = await import("child_process");
    const result = execSync("git remote get-url origin", {
      cwd: workspacePath,
      encoding: "utf8",
    });
    return result.includes("github.com");
  } catch {
    return false;
  }
}
