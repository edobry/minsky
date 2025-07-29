/**
 * Session Conflicts Operations
 *
 * Provides session-specific conflict detection functionality that operates
 * within session workspaces and includes session metadata.
 */

import { analyzeConflictRegions } from "../git/conflict-analysis-operations";
import { getCurrentSessionContext } from "../workspace";
import { getSessionDirFromParams } from "../session";
import { getCurrentWorkingDirectory } from "../../utils/process";
import { execAsync } from "../../utils/exec";
import { log } from "../../utils/logger";

export interface SessionConflictScanOptions {
  format?: "json" | "text";
  context?: number;
  files?: string;
}

export interface ConflictBlock {
  startLine: number;
  endLine: number;
  ours: {
    content: string;
    lines: number[];
  };
  theirs: {
    content: string;
    lines: number[];
  };
  context: {
    before: string[];
    after: string[];
  };
}

export interface ConflictedFile {
  file: string;
  blocks: ConflictBlock[];
}

export interface SessionConflictScanResult {
  repository: string;
  session?: string;
  timestamp: string;
  conflicts: ConflictedFile[];
  summary: {
    totalFiles: number;
    totalConflicts: number;
    totalBlocks: number;
  };
}

export interface SessionConflictParams {
  name?: string;
  task?: string;
}

/**
 * Scan a session workspace for conflict markers
 * Supports both --name and --task parameters like other session commands
 */
export async function scanSessionConflicts(
  params: SessionConflictParams,
  options: SessionConflictScanOptions = {}
): Promise<SessionConflictScanResult> {
  try {
    let sessionPath: string;
    let actualSessionName: string;

    if (params.name) {
      // Get specific session by name
      const sessionDir = await getSessionDirFromParams({ session: params.name });
      sessionPath = sessionDir;
      actualSessionName = params.name;
    } else if (params.task) {
      // Get session by task ID
      const sessionDir = await getSessionDirFromParams({ task: params.task });
      sessionPath = sessionDir;
      // Extract session name from path
      actualSessionName = sessionPath.split("/").pop() || `task${params.task}`;
    } else {
      // Auto-detect current session from working directory
      const cwd = getCurrentWorkingDirectory();
      const context = await getCurrentSessionContext(cwd);

      if (!context) {
        throw new Error(
          "No session detected. Please provide a session name (--name), task ID (--task), or run this command from within a session workspace."
        );
      }

      // Use current working directory as session path and extract session name from sessionId
      sessionPath = cwd;
      actualSessionName = context.sessionId;
    }

    log.debug("Scanning session for conflicts", {
      sessionName: actualSessionName,
      sessionPath,
      options,
    });

    const files = await findFilesToScan(sessionPath, options.files);
    const conflictedFiles: ConflictedFile[] = [];

    for (const file of files) {
      const blocks = await scanFileForConflicts(sessionPath, file, options.context || 3);
      if (blocks.length > 0) {
        conflictedFiles.push({
          file,
          blocks,
        });
      }
    }

    const totalBlocks = conflictedFiles.reduce((sum, file) => sum + file.blocks.length, 0);

    const result: SessionConflictScanResult = {
      repository: sessionPath,
      session: actualSessionName,
      timestamp: new Date().toISOString(),
      conflicts: conflictedFiles,
      summary: {
        totalFiles: conflictedFiles.length,
        totalConflicts: conflictedFiles.length,
        totalBlocks,
      },
    };

    return result;
  } catch (error) {
    log.error("Error scanning session for conflicts", { error, params, options });
    throw error;
  }
}

/**
 * Find files to scan based on pattern or default git files
 */
async function findFilesToScan(repoPath: string, pattern?: string): Promise<string[]> {
  try {
    let command: string;

    if (pattern) {
      // Use find with pattern
      command = `find . -name "${pattern}" -type f`;
    } else {
      // Use git ls-files to get tracked files
      command = "git ls-files";
    }

    const { stdout } = await execAsync(command, { cwd: repoPath });
    const files = stdout
      .toString()
      .trim()
      .split("\n")
      .filter((file) => file.length > 0)
      .filter((file) => !file.startsWith(".git/"))
      .filter((file) => isTextFile(file));

    log.debug("Found files to scan", { count: files.length, pattern });
    return files;
  } catch (error) {
    log.error("Error finding files to scan", { error, repoPath, pattern });
    return [];
  }
}

/**
 * Check if a file is likely a text file (simple heuristic)
 */
function isTextFile(fileName: string): boolean {
  const textExtensions = [
    ".ts",
    ".js",
    ".tsx",
    ".jsx",
    ".json",
    ".md",
    ".txt",
    ".yml",
    ".yaml",
    ".xml",
    ".html",
    ".css",
    ".scss",
    ".less",
    ".py",
    ".java",
    ".c",
    ".cpp",
    ".h",
    ".hpp",
    ".cs",
    ".php",
    ".rb",
    ".go",
    ".rs",
    ".sh",
    ".bash",
    ".zsh",
    ".sql",
    ".toml",
    ".ini",
    ".conf",
    ".config",
  ];

  const binaryExtensions = [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".bmp",
    ".ico",
    ".svg",
    ".pdf",
    ".zip",
    ".tar",
    ".gz",
    ".rar",
    ".7z",
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".bin",
    ".o",
    ".obj",
    ".a",
    ".lib",
  ];

  const ext = fileName.toLowerCase().substring(fileName.lastIndexOf("."));

  // If it's explicitly a binary extension, skip it
  if (binaryExtensions.includes(ext)) {
    return false;
  }

  // If it's a known text extension or has no extension, include it
  return textExtensions.includes(ext) || !ext;
}

/**
 * Scan a single file for conflict markers using existing conflict analysis
 */
async function scanFileForConflicts(
  repoPath: string,
  filePath: string,
  contextLines: number
): Promise<ConflictBlock[]> {
  try {
    // Reuse existing conflict detection logic
    const regions = await analyzeConflictRegions(repoPath, filePath);

    if (regions.length === 0) {
      return [];
    }

    // Convert existing ConflictRegion format to our ConflictBlock format
    const blocks: ConflictBlock[] = [];

    for (const region of regions) {
      const block = await parseConflictRegion(repoPath, filePath, region, contextLines);
      if (block) {
        blocks.push(block);
      }
    }

    if (blocks.length > 0) {
      log.debug("Found conflict blocks in file", {
        filePath,
        blockCount: blocks.length,
      });
    }

    return blocks;
  } catch (error) {
    log.warn("Could not scan file for conflicts", { error, filePath });
    return [];
  }
}

/**
 * Parse a conflict region to extract detailed content and context
 */
async function parseConflictRegion(
  repoPath: string,
  filePath: string,
  region: { startLine: number; endLine: number },
  contextLines: number
): Promise<ConflictBlock | null> {
  try {
    const fs = await import("fs/promises");
    const path = await import("path");

    const fullPath = path.join(repoPath, filePath);
    const content = await fs.readFile(fullPath, "utf-8");
    const lines = content.toString().split("\n");

    // Find conflict markers within the region
    let separatorIndex = -1;
    const startIndex = region.startLine - 1; // Convert to 0-based
    const endIndex = region.endLine - 1;

    for (let i = startIndex; i <= endIndex; i++) {
      const line = lines[i];
      if (line && line.startsWith("=======")) {
        separatorIndex = i;
        break;
      }
    }

    if (separatorIndex === -1) {
      return null; // No separator found
    }

    // Extract "ours" content (between start and separator)
    const oursLines: number[] = [];
    const oursContent: string[] = [];
    for (let i = startIndex + 1; i < separatorIndex; i++) {
      oursLines.push(i + 1); // 1-based line numbers
      const line = lines[i];
      if (line !== undefined) {
        oursContent.push(line);
      }
    }

    // Extract "theirs" content (between separator and end)
    const theirsLines: number[] = [];
    const theirsContent: string[] = [];
    for (let i = separatorIndex + 1; i < endIndex; i++) {
      theirsLines.push(i + 1); // 1-based line numbers
      const line = lines[i];
      if (line !== undefined) {
        theirsContent.push(line);
      }
    }

    // Extract context before and after
    const beforeStart = Math.max(0, startIndex - contextLines);
    const beforeContext: string[] = [];
    for (let i = beforeStart; i < startIndex; i++) {
      const line = lines[i];
      if (line !== undefined) {
        beforeContext.push(line);
      }
    }

    const afterEnd = Math.min(lines.length, endIndex + 1 + contextLines);
    const afterContext: string[] = [];
    for (let i = endIndex + 1; i < afterEnd; i++) {
      const line = lines[i];
      if (line !== undefined) {
        afterContext.push(line);
      }
    }

    return {
      startLine: region.startLine,
      endLine: region.endLine,
      ours: {
        content: oursContent.join("\n"),
        lines: oursLines,
      },
      theirs: {
        content: theirsContent.join("\n"),
        lines: theirsLines,
      },
      context: {
        before: beforeContext,
        after: afterContext,
      },
    };
  } catch (error) {
    log.warn("Could not parse conflict region", { error, filePath, region });
    return null;
  }
}

/**
 * Format session conflict results with additional session context
 */
export function formatSessionConflictResults(
  result: SessionConflictScanResult,
  format: "json" | "text" = "json"
): string {
  if (format === "text") {
    const output: string[] = [];

    output.push(`Session Conflict Scan Results`);
    output.push(`Session: ${result.session || "unknown"}`);
    output.push(`Session Workspace: ${result.repository}`);
    output.push(`Scan Time: ${result.timestamp}`);
    output.push(`\nSummary:`);
    output.push(`  Total Files with Conflicts: ${result.summary.totalFiles}`);
    output.push(`  Total Conflict Blocks: ${result.summary.totalBlocks}`);
    output.push("");

    if (result.conflicts.length === 0) {
      output.push("No conflicts found.");
      return output.join("\n");
    }

    for (const file of result.conflicts) {
      output.push(`File: ${file.file}`);
      output.push(`  Conflict blocks: ${file.blocks.length}`);

      for (let i = 0; i < file.blocks.length; i++) {
        const block = file.blocks[i];
        if (block) {
          output.push(`\n  Block ${i + 1} (lines ${block.startLine}-${block.endLine}):`);

          // Show context before
          if (block.context.before.length > 0) {
            output.push("    Context before:");
            block.context.before.forEach((line) => output.push(`      ${line}`));
          }

          // Show ours
          output.push("    Ours:");
          block.ours.content.split("\n").forEach((line) => output.push(`      ${line}`));

          // Show theirs
          output.push("    Theirs:");
          block.theirs.content.split("\n").forEach((line) => output.push(`      ${line}`));

          // Show context after
          if (block.context.after.length > 0) {
            output.push("    Context after:");
            block.context.after.forEach((line) => output.push(`      ${line}`));
          }
        }
      }
      output.push("");
    }

    return output.join("\n");
  } else {
    return JSON.stringify(result, null, 2);
  }
}
