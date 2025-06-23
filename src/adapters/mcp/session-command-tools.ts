/**
 * MCP adapter for session-aware command execution tools
 * Provides session-scoped run_terminal_cmd, list_dir, and read_file tools that match Cursor's interface
 */
import type { CommandMapper } from "../../mcp/command-mapper.js";
import { z } from "zod";
import { readdir, stat, readFile } from "fs/promises";
import { join, relative } from "path";
import { SessionPathResolver } from "./session-files.js";
import { log } from "../../utils/logger.js";
import { spawn } from "child_process";

/**
 * Interface for terminal command execution
 */
interface RunCommandArgs {
  session: string;
  command: string;
  is_background?: boolean;
}

/**
 * Interface for directory listing
 */
interface ListDirArgs {
  session: string;
  relative_workspace_path: string;
}

/**
 * Interface for file reading
 */
interface ReadFileArgs {
  session: string;
  target_file: string;
  should_read_entire_file: boolean;
  start_line_one_indexed: number;
  end_line_one_indexed_inclusive: number;
}

/**
 * Shell context manager for persistent shell sessions
 */
class SessionShellManager {
  static async executeCommand(sessionId: string, command: string, workingDir: string, isBackground: boolean = false): Promise<{
    exitCode: number;
    output: string;
    error?: string;
  }> {
    return new Promise((resolve, reject) => {
      const child = spawn("sh", ["-c", command], {
        cwd: workingDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      if (isBackground) {
        // For background processes, return immediately
        resolve({
          exitCode: 0,
          output: `Background process started with PID ${child.pid}\n`,
        });
        return;
      }

      child.on("close", (code) => {
        resolve({
          exitCode: code || 0,
          output: stdout,
          error: stderr || undefined,
        });
      });

      child.on("error", (error) => {
        reject(error);
      });

      // Set timeout for commands (30 seconds)
      setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Command timeout after 30 seconds"));
      }, 30000);
    });
  }
}

/**
 * File size formatter matching Cursor's format
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

/**
 * Line counter for files
 */
async function countLines(filePath: string): Promise<number> {
  try {
    const content = await readFile(filePath, "utf-8") as string;
    return content.split("\n").length;
  } catch (error) {
    return 0;
  }
}

/**
 * Registers session-aware command execution tools with the MCP command mapper
 */
export function registerSessionCommandTools(commandMapper: CommandMapper): void {
  const pathResolver = new SessionPathResolver();

  // Session run command tool
  commandMapper.addTool(
    "session_run_command",
    "Execute terminal commands within a session workspace with persistent shell context",
    z.object({
      session: z.string().describe("Session identifier (name or task ID)"),
      command: z.string().describe("The terminal command to execute"),
      is_background: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether the command should be run in the background"),
    }),
    async (args: RunCommandArgs): Promise<Record<string, unknown>> => {
      try {
        const sessionPath = await pathResolver.getSessionWorkspacePath(args.session);
        
        log.debug("Executing session command", {
          session: args.session,
          command: args.command,
          background: args.is_background,
          workingDir: sessionPath,
        });

        const result = await SessionShellManager.executeCommand(
          args.session,
          args.command,
          sessionPath,
          args.is_background || false
        );

        const output = `Exit code: ${result.exitCode}

Command output:

${result.output.trimEnd()}

Command completed.

The previous shell command ended, so on the next invocation of this tool, you will be reusing the shell.

On the next terminal tool call, the directory of the shell will already be ${sessionPath}.`;

        log.debug("Session command executed successfully", {
          session: args.session,
          command: args.command,
          exitCode: result.exitCode,
        });

        return {
          success: true,
          session: args.session,
          command: args.command,
          exitCode: result.exitCode,
          output,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error("Session command execution failed", {
          session: args.session,
          command: args.command,
          error: errorMessage,
        });

        return {
          success: false,
          error: errorMessage,
          session: args.session,
          command: args.command,
        };
      }
    }
  );

  // Session list directory tool
  commandMapper.addTool(
    "session_list_dir",
    "List the contents of a directory within a session workspace",
    z.object({
      session: z.string().describe("Session identifier (name or task ID)"),
      relative_workspace_path: z
        .string()
        .describe("Path to list contents of, relative to the session workspace root"),
    }),
    async (args: ListDirArgs): Promise<Record<string, unknown>> => {
      try {
        const sessionPath = await pathResolver.getSessionWorkspacePath(args.session);
        
        // Validate path is within session boundaries
        const resolvedPath = await pathResolver.resolvePath(args.session, args.relative_workspace_path);
        
        log.debug("Listing session directory", {
          session: args.session,
          relativePath: args.relative_workspace_path,
          targetPath: resolvedPath,
        });

        const items = await readdir(resolvedPath);
        const itemDetails: string[] = [];

        for (const item of items.sort()) {
          const itemPath = join(resolvedPath, item);
          const stats = await stat(itemPath);
          
          if (stats.isDirectory()) {
            // Count items in directory
            let itemCount;
            try {
              const subItems = await readdir(itemPath);
              itemCount = `${subItems.length} items`;
            } catch (error) {
              itemCount = "? items";
            }
            itemDetails.push(`[dir]  ${item}/ (${itemCount})`);
          } else {
            // File with size and line count
            const size = formatFileSize(stats.size);
            const lines = await countLines(itemPath);
            itemDetails.push(`[file] ${item} (${size}, ${lines} lines)`);
          }
        }

        const output = `Contents of directory:

${itemDetails.join("\n")}`;

        log.debug("Session directory listing successful", {
          session: args.session,
          relativePath: args.relative_workspace_path,
          itemCount: items.length,
        });

        return {
          success: true,
          session: args.session,
          path: args.relative_workspace_path,
          contents: output,
          itemCount: items.length,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error("Session directory listing failed", {
          session: args.session,
          relativePath: args.relative_workspace_path,
          error: errorMessage,
        });

        return {
          success: false,
          error: errorMessage,
          session: args.session,
          path: args.relative_workspace_path,
        };
      }
    }
  );

  // Session read file tool
  commandMapper.addTool(
    "session_read_file",
    "Read the contents of a file within a session workspace with optional line range",
    z.object({
      session: z.string().describe("Session identifier (name or task ID)"),
      target_file: z.string().describe("The path of the file to read, relative to session workspace"),
      should_read_entire_file: z.boolean().describe("Whether to read the entire file"),
      start_line_one_indexed: z.number().describe("The one-indexed line number to start reading from (inclusive)"),
      end_line_one_indexed_inclusive: z.number().describe("The one-indexed line number to end reading at (inclusive)"),
    }),
    async (args: ReadFileArgs): Promise<Record<string, unknown>> => {
      try {
        const sessionPath = await pathResolver.getSessionWorkspacePath(args.session);
        const resolvedPath = await pathResolver.resolvePath(args.session, args.target_file);
        
        log.debug("Reading session file", {
          session: args.session,
          targetFile: args.target_file,
          resolvedPath,
          entireFile: args.should_read_entire_file,
          startLine: args.start_line_one_indexed,
          endLine: args.end_line_one_indexed_inclusive,
        });

        const content = await readFile(resolvedPath, "utf-8") as string;
        const lines = content.split("\n");
        const totalLines = lines.length;

        let outputContent: string;
        let summary = "";

        if (args.should_read_entire_file) {
          outputContent = content;
        } else {
          const startIdx = Math.max(0, args.start_line_one_indexed - 1);
          const endIdx = Math.min(totalLines, args.end_line_one_indexed_inclusive);
          
          // Extract requested lines
          const selectedLines = lines.slice(startIdx, endIdx);
          outputContent = selectedLines.join("\n");
          
          // Generate summary for excluded lines
          if (startIdx > 0) {
            summary += `Lines 1-${startIdx} not shown. `;
          }
          if (endIdx < totalLines) {
            summary += `Lines ${endIdx + 1}-${totalLines} not shown.`;
          }
          if (summary) {
            summary = `${summary.trim()}\n\n`;
          }
        }

        const output = args.should_read_entire_file
          ? `Contents of ${args.target_file}:\n\`\`\`\n${outputContent}\n\`\`\``
          : `Contents of ${args.target_file}, lines ${args.start_line_one_indexed}-${args.end_line_one_indexed_inclusive} (total ${totalLines} lines):\n${summary}\`\`\`\n${outputContent}\n\`\`\``;

        log.debug("Session file read successful", {
          session: args.session,
          targetFile: args.target_file,
          totalLines,
          readLines: outputContent.split("\n").length,
        });

        return {
          success: true,
          session: args.session,
          file: args.target_file,
          content: output,
          totalLines,
          linesRead: outputContent.split("\n").length,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error("Session file read failed", {
          session: args.session,
          targetFile: args.target_file,
          error: errorMessage,
        });

        return {
          success: false,
          error: errorMessage,
          session: args.session,
          file: args.target_file,
        };
      }
    }
  );
} 
