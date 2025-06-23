/**
 * MCP adapter for session-aware search operations
 * Provides session-scoped grep_search, file_search, and codebase_search tools that match Cursor's interface
 */
import type { CommandMapper } from "../../mcp/command-mapper.js";
import { z } from "zod";
import { readdir, stat } from "fs/promises";
import { join, relative, sep } from "path";
import { SessionPathResolver } from "./session-files.js";
import { log } from "../../utils/logger.js";
import { spawn } from "child_process";
import { promisify } from "util";
import { glob } from "glob";

/**
 * Interface for grep search operation
 */
interface GrepSearchArgs {
  session: string;
  query: string;
  case_sensitive?: boolean;
  include_pattern?: string;
  exclude_pattern?: string;
}

/**
 * Interface for file search operation
 */
interface FileSearchArgs {
  session: string;
  query: string;
}

/**
 * Interface for codebase search operation
 */
interface CodebaseSearchArgs {
  session: string;
  query: string;
  target_directories?: string[];
}

/**
 * Interface for grep search result
 */
interface GrepSearchResult {
  file: string;
  line: number;
  content: string;
}

/**
 * Interface for file search result
 */
interface FileSearchResult {
  path: string;
  score: number;
}

/**
 * Interface for codebase search result
 */
interface CodebaseSearchResult {
  file: string;
  line: number;
  content: string;
  context: string[];
}

/**
 * Registers session-aware search tools with the MCP command mapper
 */
export function registerSessionSearchTools(commandMapper: CommandMapper): void {
  const pathResolver = new SessionPathResolver();

  // Session grep search tool
  commandMapper.addTool(
    "session_grep_search",
    "Search for patterns in files within a session workspace using regex",
    z.object({
      session: z.string().describe("Session identifier (name or task ID)"),
      query: z.string().describe("Search pattern (supports regex)"),
      case_sensitive: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether the search should be case sensitive"),
      include_pattern: z
        .string()
        .optional()
        .describe("Glob pattern for files to include (e.g. '*.ts' for TypeScript files)"),
      exclude_pattern: z
        .string()
        .optional()
        .describe("Glob pattern for files to exclude"),
    }),
    async (args: GrepSearchArgs): Promise<Record<string, unknown>> => {
      try {
        const sessionPath = await pathResolver.getSessionPath(args.session);
        
        // Build ripgrep command
        const rgArgs = [
          "--line-number",
          "--with-filename",
          "--no-heading",
          "--color=never",
          "--max-count=50", // Limit to 50 matches per file
        ];

        // Case sensitivity
        if (!args.case_sensitive) {
          rgArgs.push("--ignore-case");
        }

        // Include pattern
        if (args.include_pattern) {
          rgArgs.push("--glob", args.include_pattern);
        }

        // Exclude pattern
        if (args.exclude_pattern) {
          rgArgs.push("--glob", `!${args.exclude_pattern}`);
        }

        // Add query and search path
        rgArgs.push(args.query, sessionPath);

        // Execute ripgrep
        const results = await executeRipgrep(rgArgs);
        
        // Format results to match Cursor's interface
        const formattedOutput = formatGrepResults(results, sessionPath);
        
        log.debug("Session grep search successful", {
          session: args.session,
          query: args.query,
          resultCount: results.length,
        });

        return {
          success: true,
          session: args.session,
          query: args.query,
          results: formattedOutput,
          totalMatches: results.length,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error("Session grep search failed", {
          session: args.session,
          query: args.query,
          error: errorMessage,
        });

        return {
          success: false,
          error: errorMessage,
          session: args.session,
          query: args.query,
        };
      }
    }
  );

  // Session file search tool
  commandMapper.addTool(
    "session_file_search",
    "Search for files by name within a session workspace using fuzzy matching",
    z.object({
      session: z.string().describe("Session identifier (name or task ID)"),
      query: z.string().describe("File name or partial path to search for"),
    }),
    async (args: FileSearchArgs): Promise<Record<string, unknown>> => {
      try {
        const sessionPath = await pathResolver.getSessionPath(args.session);
        
        // Get all files in session workspace
        const allFiles = await getAllFiles(sessionPath);
        
        // Perform fuzzy matching
        const matches = performFuzzySearch(allFiles, args.query, sessionPath);
        
        // Limit to 10 results as per Cursor behavior
        const limitedMatches = matches.slice(0, 10);
        
        log.debug("Session file search successful", {
          session: args.session,
          query: args.query,
          totalFiles: allFiles.length,
          matchCount: matches.length,
          returnedCount: limitedMatches.length,
        });

        return {
          success: true,
          session: args.session,
          query: args.query,
          results: limitedMatches.map(match => match.path),
          totalResults: matches.length,
          message: limitedMatches.length < matches.length 
            ? `These are the first 10 results. There were ${matches.length} total results from the search.`
            : undefined,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error("Session file search failed", {
          session: args.session,
          query: args.query,
          error: errorMessage,
        });

        return {
          success: false,
          error: errorMessage,
          session: args.session,
          query: args.query,
        };
      }
    }
  );

  // Session codebase search tool
  commandMapper.addTool(
    "session_codebase_search",
    "Semantic search for code patterns and concepts within a session workspace",
    z.object({
      session: z.string().describe("Session identifier (name or task ID)"),
      query: z.string().describe("Search query describing what to look for"),
      target_directories: z
        .array(z.string())
        .optional()
        .describe("Glob patterns for directories to search over"),
    }),
    async (args: CodebaseSearchArgs): Promise<Record<string, unknown>> => {
      try {
        const sessionPath = await pathResolver.getSessionPath(args.session);
        
        // For now, implement as enhanced grep search with semantic keywords
        // TODO: Implement true semantic search with embeddings in future
        const semanticQuery = expandSemanticQuery(args.query);
        
        // Build search parameters
        const searchPaths = args.target_directories 
          ? await expandGlobPatterns(args.target_directories, sessionPath)
          : [sessionPath];

        // Perform enhanced search
        const results = await performSemanticSearch(semanticQuery, searchPaths);
        
        // Format results with context
        const formattedResults = await formatCodebaseResults(results, sessionPath);
        
        log.debug("Session codebase search successful", {
          session: args.session,
          query: args.query,
          semanticQuery,
          resultCount: results.length,
        });

        return {
          success: true,
          session: args.session,
          query: args.query,
          results: formattedResults,
          totalMatches: results.length,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error("Session codebase search failed", {
          session: args.session,
          query: args.query,
          error: errorMessage,
        });

        return {
          success: false,
          error: errorMessage,
          session: args.session,
          query: args.query,
        };
      }
    }
  );
}

/**
 * Execute ripgrep command and parse results
 */
async function executeRipgrep(args: string[]): Promise<GrepSearchResult[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("rg", args, { stdio: ["pipe", "pipe", "pipe"] });
    
    let stdout = "";
    let stderr = "";
    
    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    
    child.on("close", (code) => {
      if (code === 0 || code === 1) { // 0 = matches found, 1 = no matches
        const results = parseRipgrepOutput(stdout);
        resolve(results);
      } else {
        reject(new Error(`ripgrep failed with code ${code}: ${stderr}`));
      }
    });
    
    child.on("error", (error) => {
      reject(error);
    });
  });
}

/**
 * Parse ripgrep output into structured results
 */
function parseRipgrepOutput(output: string): GrepSearchResult[] {
  const results: GrepSearchResult[] = [];
  const lines = output.trim().split("\n");
  
  for (const line of lines) {
    if (!line.trim()) continue;
    
    // Parse format: filename:line:content
    const match = line.match(/^([^:]+):(\d+):(.*)$/);
    if (match) {
      results.push({
        file: match[1],
        line: parseInt(match[2], 10),
        content: match[3],
      });
    }
  }
  
  return results;
}

/**
 * Format grep results to match Cursor's output format
 */
function formatGrepResults(results: GrepSearchResult[], sessionPath: string): string {
  if (results.length === 0) {
    return "No matches found.";
  }
  
  const output: string[] = [];
  let currentFile = "";
  
  for (const result of results.slice(0, 50)) { // Limit to 50 matches
    const relativePath = relative(sessionPath, result.file);
    const fileUrl = `file://${result.file}`;
    
    if (currentFile !== fileUrl) {
      output.push(`File: ${fileUrl}`);
      currentFile = fileUrl;
    }
    
    output.push(`Line ${result.line}: ${result.content}`);
  }
  
  if (results.length > 50) {
    output.push("");
    output.push("NOTE: More results are available, but aren't shown here. If you need to, please refine the search query or restrict the scope.");
  }
  
  return output.join("\n");
}

/**
 * Get all files in a directory recursively
 */
async function getAllFiles(dirPath: string): Promise<string[]> {
  const files: string[] = [];
  
  async function traverse(currentPath: string): Promise<void> {
    try {
      const entries = await readdir(currentPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = join(currentPath, entry.name);
        
        if (entry.isDirectory()) {
          // Skip common directories that shouldn't be searched
          if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
            await traverse(fullPath);
          }
        } else if (entry.isFile()) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      // Skip directories we can't read
      log.debug("Skipping directory in file search", { path: currentPath, error });
    }
  }
  
  await traverse(dirPath);
  return files;
}

/**
 * Perform fuzzy search on file paths
 */
function performFuzzySearch(files: string[], query: string, sessionPath: string): FileSearchResult[] {
  const queryLower = query.toLowerCase();
  const results: FileSearchResult[] = [];
  
  for (const file of files) {
    const relativePath = relative(sessionPath, file);
    const fileName = relativePath.split(sep).pop() || "";
    const pathLower = relativePath.toLowerCase();
    const fileNameLower = fileName.toLowerCase();
    
    let score = 0;
    
    // Exact filename match gets highest score
    if (fileNameLower === queryLower) {
      score = 1000;
    }
    // Filename starts with query
    else if (fileNameLower.startsWith(queryLower)) {
      score = 800;
    }
    // Filename contains query
    else if (fileNameLower.includes(queryLower)) {
      score = 600;
    }
    // Path contains query
    else if (pathLower.includes(queryLower)) {
      score = 400;
    }
    // Fuzzy match on filename
    else if (fuzzyMatch(fileNameLower, queryLower)) {
      score = 200;
    }
    // Fuzzy match on path
    else if (fuzzyMatch(pathLower, queryLower)) {
      score = 100;
    }
    
    if (score > 0) {
      results.push({
        path: file,
        score,
      });
    }
  }
  
  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
  
  return results;
}

/**
 * Simple fuzzy matching algorithm
 */
function fuzzyMatch(text: string, pattern: string): boolean {
  let textIndex = 0;
  let patternIndex = 0;
  
  while (textIndex < text.length && patternIndex < pattern.length) {
    if (text[textIndex] === pattern[patternIndex]) {
      patternIndex++;
    }
    textIndex++;
  }
  
  return patternIndex === pattern.length;
}

/**
 * Expand semantic query to include related terms
 */
function expandSemanticQuery(query: string): string {
  const expansions: Record<string, string[]> = {
    "error handling": ["try", "catch", "throw", "error", "exception", "ErrorHandler"],
    "validation": ["validate", "check", "verify", "assert", "isValid"],
    "configuration": ["config", "settings", "options", "configure"],
    "database": ["db", "database", "connection", "query", "sql"],
    "authentication": ["auth", "login", "password", "token", "jwt"],
    "logging": ["log", "logger", "debug", "info", "warn", "error"],
  };
  
  const queryLower = query.toLowerCase();
  
  for (const [concept, terms] of Object.entries(expansions)) {
    if (queryLower.includes(concept)) {
      return `(${query}|${terms.join("|")})`;
    }
  }
  
  return query;
}

/**
 * Expand glob patterns to actual directory paths
 */
async function expandGlobPatterns(patterns: string[], sessionPath: string): Promise<string[]> {
  const paths: string[] = [];
  
  for (const pattern of patterns) {
    try {
      const matches = await glob(pattern, { cwd: sessionPath });
      for (const match of matches) {
        const fullPath = join(sessionPath, match);
        const stats = await stat(fullPath);
        if (stats.isDirectory()) {
          paths.push(fullPath);
        }
      }
    } catch (error) {
      log.debug("Failed to expand glob pattern", { pattern, error });
    }
  }
  
  return paths.length > 0 ? paths : [sessionPath];
}

/**
 * Perform semantic search using enhanced grep
 */
async function performSemanticSearch(query: string, searchPaths: string[]): Promise<GrepSearchResult[]> {
  const allResults: GrepSearchResult[] = [];
  
  for (const searchPath of searchPaths) {
    const rgArgs = [
      "--line-number",
      "--with-filename", 
      "--no-heading",
      "--color=never",
      "--ignore-case",
      "--context=2", // Include 2 lines of context
      query,
      searchPath,
    ];
    
    try {
      const results = await executeRipgrep(rgArgs);
      allResults.push(...results);
    } catch (error) {
      log.debug("Semantic search failed for path", { searchPath, error });
    }
  }
  
  return allResults;
}

/**
 * Format codebase search results with context
 */
async function formatCodebaseResults(results: GrepSearchResult[], sessionPath: string): Promise<string> {
  if (results.length === 0) {
    return "No matches found.";
  }
  
  const output: string[] = [];
  const groupedResults = groupResultsByFile(results);
  
  for (const [file, fileResults] of groupedResults.entries()) {
    const relativePath = relative(sessionPath, file);
    output.push(`\n## ${relativePath}\n`);
    
    for (const result of fileResults.slice(0, 5)) { // Limit results per file
      output.push(`Line ${result.line}: ${result.content}`);
    }
    
    if (fileResults.length > 5) {
      output.push(`... and ${fileResults.length - 5} more matches in this file`);
    }
  }
  
  return output.join("\n");
}

/**
 * Group search results by file
 */
function groupResultsByFile(results: GrepSearchResult[]): Map<string, GrepSearchResult[]> {
  const grouped = new Map<string, GrepSearchResult[]>();
  
  for (const result of results) {
    if (!grouped.has(result.file)) {
      grouped.set(result.file, []);
    }
    grouped.get(result.file)!.push(result);
  }
  
  return grouped;
} 
