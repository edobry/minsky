/**
 * Conflict Scanner Service
 *
 * Provides functionality to scan files for merge conflict markers and extract
 * structured information about conflicts for programmatic consumption.
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { execAsync } from "../../utils/exec";
import { log } from "../../utils/logger";

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

export interface ConflictScanResult {
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

export interface ConflictScanOptions {
  format?: "json" | "text";
  context?: number;
  files?: string;
}

/**
 * Service for scanning repositories for conflict markers
 */
export class ConflictScanner {
  /**
   * Scan a repository for conflict markers
   */
  static async scanRepository(
    repoPath: string,
    options: ConflictScanOptions = {},
    sessionName?: string
  ): Promise<ConflictScanResult> {
    const scanner = new ConflictScanner();
    return scanner.scanRepository(repoPath, options, sessionName);
  }

  /**
   * Scan a repository for conflict markers
   */
  async scanRepository(
    repoPath: string,
    options: ConflictScanOptions = {},
    sessionName?: string
  ): Promise<ConflictScanResult> {
    log.debug("Scanning repository for conflicts", {
      repoPath,
      options,
      sessionName,
    });

    try {
      const files = await this.findFilesToScan(repoPath, options.files);
      const conflictedFiles: ConflictedFile[] = [];

      for (const file of files) {
        const blocks = await this.scanFileForConflicts(repoPath, file, options.context || 3);
        if (blocks.length > 0) {
          conflictedFiles.push({
            file,
            blocks,
          });
        }
      }

      const totalBlocks = conflictedFiles.reduce((sum, file) => sum + file.blocks.length, 0);

      return {
        repository: repoPath,
        session: sessionName,
        timestamp: new Date().toISOString(),
        conflicts: conflictedFiles,
        summary: {
          totalFiles: conflictedFiles.length,
          totalConflicts: conflictedFiles.length,
          totalBlocks,
        },
      };
    } catch (error) {
      log.error("Error scanning repository for conflicts", { error, repoPath });
      throw error;
    }
  }

  /**
   * Find files to scan based on pattern or default git files
   */
  private async findFilesToScan(repoPath: string, pattern?: string): Promise<string[]> {
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
        .filter(file => file.length > 0)
        .filter(file => !file.startsWith(".git/"))
        .filter(file => this.isTextFile(file));

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
  private isTextFile(fileName: string): boolean {
    const textExtensions = [
      ".ts", ".js", ".tsx", ".jsx", ".json", ".md", ".txt", ".yml", ".yaml",
      ".xml", ".html", ".css", ".scss", ".less", ".py", ".java", ".c", ".cpp",
      ".h", ".hpp", ".cs", ".php", ".rb", ".go", ".rs", ".sh", ".bash", ".zsh",
      ".sql", ".toml", ".ini", ".conf", ".config"
    ];
    
    const binaryExtensions = [
      ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg", ".pdf",
      ".zip", ".tar", ".gz", ".rar", ".7z", ".exe", ".dll", ".so", ".dylib",
      ".bin", ".o", ".obj", ".a", ".lib"
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
   * Scan a single file for conflict markers
   */
  private async scanFileForConflicts(
    repoPath: string,
    filePath: string,
    contextLines: number
  ): Promise<ConflictBlock[]> {
    try {
      const fullPath = join(repoPath, filePath);
      const content = await readFile(fullPath, "utf-8");
      const lines = content.toString().split("\n");
      
      const blocks: ConflictBlock[] = [];
      let i = 0;

      while (i < lines.length) {
        const line = lines[i];
        
        // Look for start of conflict marker
        if (line && line.startsWith("<<<<<<<")) {
          const block = this.parseConflictBlock(lines, i, contextLines);
          if (block) {
            blocks.push(block);
            i = block.endLine;
          } else {
            i++;
          }
        } else {
          i++;
        }
      }

      if (blocks.length > 0) {
        log.debug("Found conflict blocks in file", { filePath, blockCount: blocks.length });
      }

      return blocks;
    } catch (error) {
      log.warn("Could not scan file for conflicts", { error, filePath });
      return [];
    }
  }

  /**
   * Parse a conflict block starting at the given line index
   */
  private parseConflictBlock(
    lines: string[],
    startIndex: number,
    contextLines: number
  ): ConflictBlock | null {
    let separatorIndex = -1;
    let endIndex = -1;

    // Find the separator (=======) and end marker (>>>>>>>)
    for (let i = startIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      
      if (line && line.startsWith("=======") && separatorIndex === -1) {
        separatorIndex = i;
      } else if (line && line.startsWith(">>>>>>>") && separatorIndex !== -1) {
        endIndex = i;
        break;
      }
    }

    // If we didn't find both separator and end, this isn't a valid conflict block
    if (separatorIndex === -1 || endIndex === -1) {
      return null;
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
      startLine: startIndex + 1, // 1-based line numbers
      endLine: endIndex + 1, // 1-based line numbers
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
  }

  /**
   * Format scan results as text
   */
  static formatAsText(result: ConflictScanResult): string {
    const output: string[] = [];
    
    output.push(`Conflict Scan Results`);
    output.push(`Repository: ${result.repository}`);
    if (result.session) {
      output.push(`Session: ${result.session}`);
    }
    output.push(`Timestamp: ${result.timestamp}`);
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
            block.context.before.forEach(line => output.push(`      ${line}`));
          }
          
          // Show ours
          output.push("    Ours:");
          block.ours.content.split("\n").forEach(line => output.push(`      ${line}`));
          
          // Show theirs
          output.push("    Theirs:");
          block.theirs.content.split("\n").forEach(line => output.push(`      ${line}`));
          
          // Show context after
          if (block.context.after.length > 0) {
            output.push("    Context after:");
            block.context.after.forEach(line => output.push(`      ${line}`));
          }
        }
      }
      output.push("");
    }

    return output.join("\n");
  }
} 
