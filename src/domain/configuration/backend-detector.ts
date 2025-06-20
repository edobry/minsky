/**
 * Backend detector for Minsky configuration system
 * 
 * Implements auto-detection of repository characteristics to determine
 * the most appropriate task backend:
 * - GitHub remote exists → github-issues backend
 * - process/tasks.md exists → markdown backend
 * - Always fallback → json-file backend
 */

import { existsSync } from "fs";
import { join } from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { BackendDetector, DetectionRule } from "./types";

const execAsync = promisify(exec);

export class DefaultBackendDetector implements BackendDetector {
    /**
     * Detect the most appropriate backend based on detection rules
     */
    async detectBackend(workingDir: string, rules: DetectionRule[]): Promise<string> {
        for (const rule of rules) {
            const matches = await this.checkCondition(workingDir, rule.condition);
            if (matches) {
                return rule.backend;
            }
        }
        
        // Default fallback (should not reach here with proper rules)
        return "json-file";
    }

    /**
     * Check if GitHub remote exists
     */
    async githubRemoteExists(workingDir: string): Promise<boolean> {
        try {
            const { stdout } = await execAsync("git remote -v", { cwd: workingDir });
            return stdout.includes("github.com");
        } catch (error) {
            return false;
        }
    }

    /**
     * Check if tasks.md file exists
     */
    async tasksMdExists(workingDir: string): Promise<boolean> {
        const tasksMdPath = join(workingDir, "process", "tasks.md");
        return existsSync(tasksMdPath);
    }

    /**
     * Check a specific detection condition
     */
    private async checkCondition(
        workingDir: string,
        condition: "github_remote_exists" | "tasks_md_exists" | "always"
    ): Promise<boolean> {
        switch (condition) {
            case "github_remote_exists":
                return this.githubRemoteExists(workingDir);
            case "tasks_md_exists":
                return this.tasksMdExists(workingDir);
            case "always":
                return true;
            default:
                return false;
        }
    }
} 
