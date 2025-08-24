import * as fs from "fs/promises";
import * as path from "path";
import { ContextComponent, ComponentInput, ComponentInputs, ComponentOutput } from "./types";

export interface FileContentInputs extends ComponentInputs {
  relevantFiles: Array<{
    path: string;
    content: string;
    size: number;
    type: "typescript" | "javascript" | "json" | "markdown" | "text" | "other";
  }>;
  totalSize: number;
  fileCount: number;
}

/**
 * FileContentComponent - Bespoke Pattern
 *
 * Dynamically reads and analyzes relevant file contents based on user prompt
 * and workspace context. Implements intelligent file selection to avoid
 * overwhelming the context with irrelevant files.
 *
 * Features:
 * - Smart file discovery based on user prompts
 * - File type detection and appropriate handling
 * - Size limits to prevent context overflow
 * - Content preview and relevance scoring
 */
export const FileContentComponent: ContextComponent = {
  id: "file-content",
  name: "File Content",
  description: "Dynamically discovers and includes relevant file contents based on context",

  async gatherInputs(context: ComponentInput): Promise<FileContentInputs> {
    const { workspacePath, userPrompt } = context;

    try {
      // Determine relevant file patterns based on user prompt
      const filePatterns = getRelevantFilePatterns(userPrompt);

      // Discover files matching patterns
      const candidateFiles = await discoverFiles(workspacePath, filePatterns);

      // Filter and rank files by relevance
      const relevantFiles = await selectRelevantFiles(candidateFiles, userPrompt, workspacePath);

      // Read file contents with size limits
      const filesWithContent = await readFileContents(relevantFiles);

      const totalSize = filesWithContent.reduce((sum, file) => sum + file.size, 0);

      return {
        relevantFiles: filesWithContent,
        totalSize,
        fileCount: filesWithContent.length,
      };
    } catch (error) {
      console.error("Error gathering file content inputs:", error);
      return {
        relevantFiles: [],
        totalSize: 0,
        fileCount: 0,
      };
    }
  },

  render(inputs: ComponentInputs, context: ComponentInput): ComponentOutput {
    const { relevantFiles, totalSize, fileCount } = inputs as FileContentInputs;
    const { userPrompt } = context;

    if (fileCount === 0) {
      return {
        id: this.id,
        name: this.name,
        content: "No relevant files found for the current context.",
        metadata: { fileCount: 0, totalSize: 0 },
      };
    }

    // Format file contents with appropriate structure
    const sections = [`## File Contents (${fileCount} files, ${formatSize(totalSize)})`, ""];

    if (userPrompt) {
      sections.push(`*Files relevant to: "${userPrompt}"*`, "");
    }

    for (const file of relevantFiles) {
      sections.push(
        `### ${file.path} (${file.type}, ${formatSize(file.size)})`,
        "",
        `\`\`\`${getLanguageForType(file.type)}`,
        file.content,
        "```",
        ""
      );
    }

    // Add summary footer
    sections.push(
      "---",
      `**File Summary**: ${fileCount} files analyzed, ${formatSize(totalSize)} total content`
    );

    return {
      id: this.id,
      name: this.name,
      content: sections.join("\n"),
      metadata: {
        fileCount,
        totalSize,
        types: [...new Set(relevantFiles.map((f) => f.type))],
      },
    };
  },

  // Legacy method for backwards compatibility
  async generate(input: ComponentInput): Promise<ComponentOutput> {
    const inputs = await this.gatherInputs(input);
    return this.render(inputs, input);
  },
};

function getRelevantFilePatterns(userPrompt?: string): string[] {
  const basePatterns = ["**/*.ts", "**/*.js", "package.json"];

  if (!userPrompt) {
    return basePatterns;
  }

  const prompt = userPrompt.toLowerCase();
  const additionalPatterns: string[] = [];

  // Context-specific file patterns
  if (prompt.includes("test") || prompt.includes("spec")) {
    additionalPatterns.push("**/*.test.ts", "**/*.spec.ts", "**/test/**/*.ts");
  }

  if (prompt.includes("config") || prompt.includes("setup")) {
    additionalPatterns.push(
      "**/*.config.js",
      "**/*.config.ts",
      "**/tsconfig.json",
      "**/.eslintrc*"
    );
  }

  if (prompt.includes("doc") || prompt.includes("readme")) {
    additionalPatterns.push("**/*.md", "**/README*");
  }

  if (prompt.includes("type") || prompt.includes("interface")) {
    additionalPatterns.push("**/*.d.ts", "**/types.ts", "**/types/**/*.ts");
  }

  if (prompt.includes("command") || prompt.includes("cli")) {
    additionalPatterns.push("**/commands/**/*.ts", "**/cli.ts", "**/cli/**/*.ts");
  }

  return [...basePatterns, ...additionalPatterns];
}

async function discoverFiles(workspacePath: string, patterns: string[]): Promise<string[]> {
  const files: Set<string> = new Set();

  for (const pattern of patterns) {
    try {
      // Simple pattern matching - in production would use proper glob
      const matchedFiles = await simpleGlob(workspacePath, pattern);
      matchedFiles.forEach((file) => files.add(file));
    } catch (error) {
      console.warn(`Failed to match pattern ${pattern}:`, error);
    }
  }

  return Array.from(files);
}

async function simpleGlob(basePath: string, pattern: string): Promise<string[]> {
  const files: string[] = [];

  // Simple implementation - in production would use proper glob library
  if (pattern.includes("**")) {
    const extension = pattern.split(".").pop();
    if (extension) {
      await findFilesByExtension(basePath, extension, files);
    }
  } else {
    // Exact file match
    const fullPath = path.join(basePath, pattern);
    try {
      await fs.access(fullPath);
      files.push(fullPath);
    } catch {
      // File doesn't exist
    }
  }

  return files;
}

async function findFilesByExtension(
  dir: string,
  extension: string,
  results: string[]
): Promise<void> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Skip common directories that are usually not relevant
        if (!["node_modules", ".git", "dist", "build", ".next"].includes(entry.name)) {
          await findFilesByExtension(fullPath, extension, results);
        }
      } else if (entry.isFile() && entry.name.endsWith(`.${extension}`)) {
        results.push(fullPath);
      }
    }
  } catch (error) {
    // Directory not accessible, skip
  }
}

async function selectRelevantFiles(
  files: string[],
  userPrompt?: string,
  workspacePath?: string
): Promise<string[]> {
  // Limit to prevent context overflow
  const MAX_FILES = 10;
  const MAX_TOTAL_SIZE = 50000; // ~50KB

  // Score files by relevance
  const scoredFiles = files.map((file) => ({
    path: file,
    score: scoreFileRelevance(file, userPrompt, workspacePath),
  }));

  // Sort by score (highest first)
  scoredFiles.sort((a, b) => b.score - a.score);

  // Select top files within size limits
  const selected: string[] = [];
  let totalSize = 0;

  for (const { path: filePath } of scoredFiles) {
    if (selected.length >= MAX_FILES) break;

    try {
      const stat = await fs.stat(filePath);
      if (stat.size > 10000) continue; // Skip very large files

      if (totalSize + stat.size > MAX_TOTAL_SIZE) break;

      selected.push(filePath);
      totalSize += stat.size;
    } catch {
      // Skip inaccessible files
    }
  }

  return selected;
}

function scoreFileRelevance(filePath: string, userPrompt?: string, workspacePath?: string): number {
  let score = 0;
  const fileName = path.basename(filePath).toLowerCase();
  const dirName = path.dirname(filePath).toLowerCase();

  // Base score for common important files
  if (fileName === "package.json") score += 5;
  if (fileName.includes("index")) score += 3;
  if (fileName.includes("main")) score += 3;
  if (fileName.includes("config")) score += 2;

  // Reduce score for test files unless specifically requested
  if (fileName.includes("test") || fileName.includes("spec")) {
    score += userPrompt?.toLowerCase().includes("test") ? 5 : -3;
  }

  // Boost score based on user prompt
  if (userPrompt) {
    const prompt = userPrompt.toLowerCase();
    const pathLower = filePath.toLowerCase();

    // Direct mentions in path
    if (pathLower.includes(prompt)) score += 10;

    // Keyword matches
    const keywords = prompt.split(/\s+/);
    for (const keyword of keywords) {
      if (keyword.length > 2 && pathLower.includes(keyword)) {
        score += 3;
      }
    }
  }

  // Prefer files closer to workspace root
  if (workspacePath) {
    const relativePath = path.relative(workspacePath, filePath);
    const depth = relativePath.split(path.sep).length;
    score += Math.max(0, 5 - depth);
  }

  return score;
}

async function readFileContents(filePaths: string[]): Promise<
  Array<{
    path: string;
    content: string;
    size: number;
    type: "typescript" | "javascript" | "json" | "markdown" | "text" | "other";
  }>
> {
  const results = [];

  for (const filePath of filePaths) {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const type = detectFileType(filePath);

      results.push({
        path: filePath,
        content: truncateContent(content, 5000), // Limit per file
        size: content.length,
        type,
      });
    } catch (error) {
      console.warn(`Failed to read file ${filePath}:`, error);
    }
  }

  return results;
}

function detectFileType(
  filePath: string
): "typescript" | "javascript" | "json" | "markdown" | "text" | "other" {
  const ext = path.extname(filePath).toLowerCase();

  switch (ext) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
      return "javascript";
    case ".json":
      return "json";
    case ".md":
    case ".markdown":
      return "markdown";
    case ".txt":
    case ".text":
      return "text";
    default:
      return "other";
  }
}

function getLanguageForType(type: string): string {
  switch (type) {
    case "typescript":
      return "typescript";
    case "javascript":
      return "javascript";
    case "json":
      return "json";
    case "markdown":
      return "markdown";
    default:
      return "text";
  }
}

function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }

  return `${content.substring(0, maxLength - 3)}...`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function createFileContentComponent(): ContextComponent {
  return FileContentComponent;
}
