/**
 * Task Database Synchronization Utility
 *
 * Handles synchronization between special workspace and main workspace task databases
 * to ensure consistency across CLI and MCP interfaces.
 */

import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { createSpecialWorkspaceManager } from "../domain/workspace/special-workspace-manager";
import { log } from "./logger";

export interface TaskDatabaseSyncOptions {
  repoUrl?: string;
  direction?: "to-main" | "to-special" | "bidirectional";
  dryRun?: boolean;
}

/**
 * Synchronize task databases between special workspace and main workspace
 *
 * This function addresses the core issue where CLI and MCP tools use different
 * task databases, causing tasks to appear in one interface but not the other.
 *
 * @param options Synchronization options
 * @returns Sync result with details
 */
export async function syncTaskDatabases(options: TaskDatabaseSyncOptions = {}) {
  const { repoUrl, direction = "bidirectional", dryRun = false } = options;

  log.debug("Starting task database synchronization", {
    direction,
    dryRun,
    hasRepoUrl: !!repoUrl,
  });

  try {
    // Resolve paths
    const mainWorkspacePath = process.cwd();
    const mainTasksPath = join(mainWorkspacePath, "process", "tasks.md");

    // Get special workspace path
    let specialWorkspacePath: string;
    let specialTasksPath: string;

    if (repoUrl) {
      const specialWorkspaceManager = createSpecialWorkspaceManager({ repoUrl });
      await specialWorkspaceManager.initialize();
      specialWorkspacePath = specialWorkspaceManager.getWorkspacePath();
      specialTasksPath = join(specialWorkspacePath, "process", "tasks.md");
    } else {
      // Default special workspace path
      const os = await import("os");
      specialWorkspacePath = join(os.homedir(), ".local", "state", "minsky", "task-operations");
      specialTasksPath = join(specialWorkspacePath, "process", "tasks.md");
    }

    // Check what files exist
    const mainExists = existsSync(mainTasksPath);
    const specialExists = existsSync(specialTasksPath);

    log.debug("Database file existence check", {
      mainTasksPath,
      specialTasksPath,
      mainExists,
      specialExists,
    });

    if (!mainExists && !specialExists) {
      return {
        success: true,
        action: "no-sync-needed",
        message: "No task databases found to synchronize",
      };
    }

    // Determine sync direction based on what exists and options
    let syncDirection = direction;
    if (direction === "bidirectional") {
      if (mainExists && !specialExists) {
        syncDirection = "to-special";
      } else if (!mainExists && specialExists) {
        syncDirection = "to-main";
      } else if (mainExists && specialExists) {
        // Both exist - compare modification times
        const fs = await import("fs");
        const mainStat = fs.statSync(mainTasksPath);
        const specialStat = fs.statSync(specialTasksPath);

        syncDirection = mainStat.mtime > specialStat.mtime ? "to-special" : "to-main";

        log.debug("Both databases exist, using modification time", {
          mainMtime: mainStat.mtime,
          specialMtime: specialStat.mtime,
          syncDirection,
        });
      }
    }

    // Perform synchronization
    let sourceFile: string;
    let targetFile: string;

    switch (syncDirection) {
      case "to-main":
        sourceFile = specialTasksPath;
        targetFile = mainTasksPath;
        break;
      case "to-special":
        sourceFile = mainTasksPath;
        targetFile = specialTasksPath;
        break;
      default:
        throw new Error(`Invalid sync direction: ${syncDirection}`);
    }

    if (!existsSync(sourceFile)) {
      return {
        success: false,
        action: "sync-failed",
        message: `Source file does not exist: ${sourceFile}`,
      };
    }

    // Read source content
    const sourceContent = await readFile(sourceFile, "utf8");

    if (dryRun) {
      return {
        success: true,
        action: "dry-run",
        message: `Would sync from ${sourceFile} to ${targetFile}`,
        syncDirection,
        sourceLength: sourceContent.length,
      };
    }

    // Ensure target directory exists
    const targetDir = join(targetFile, "..");
    const fs = await import("fs");
    if (!existsSync(targetDir)) {
      await fs.promises.mkdir(targetDir, { recursive: true });
    }

    // Create backup of target if it exists
    if (existsSync(targetFile)) {
      const backupFile = `${targetFile}.backup.${Date.now()}`;
      await fs.promises.copyFile(targetFile, backupFile);
      log.debug("Created backup", { targetFile, backupFile });
    }

    // Write to target
    await writeFile(targetFile, sourceContent, "utf8");

    log.info("Task database synchronization completed", {
      syncDirection,
      sourceFile,
      targetFile,
      contentLength: sourceContent.length,
    });

    return {
      success: true,
      action: "synchronized",
      syncDirection,
      sourceFile,
      targetFile,
      contentLength: sourceContent.length,
    };
  } catch (error) {
    log.error("Task database synchronization failed", {
      error: error instanceof Error ? error.message : String(error),
      options,
    });

    return {
      success: false,
      action: "sync-failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Auto-sync task databases when there's a mismatch detected
 *
 * This function can be called before task operations to ensure
 * consistency between CLI and MCP interfaces.
 */
export async function autoSyncTaskDatabases(repoUrl?: string): Promise<boolean> {
  try {
    const result = await syncTaskDatabases({
      repoUrl,
      direction: "bidirectional",
      dryRun: false,
    });

    if (result.success && result.action === "synchronized") {
      log.info("Auto-sync completed", { syncDirection: result.syncDirection });
      return true;
    }

    return result.success;
  } catch (error) {
    log.warn("Auto-sync failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
