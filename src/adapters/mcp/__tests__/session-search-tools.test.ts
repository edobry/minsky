/**
 * Tests for session-aware search tools
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { registerSessionSearchTools } from "../session-search-tools";
import { CommandMapper } from "../../../mcp/command-mapper";
import { createMockMCPServer } from "../../../utils/test-utils/mock-mcp-server";
import { createTestProjectContext } from "../../../utils/test-utils/project-context";
import { createTemporaryTestWorkspace } from "../../../utils/test-utils/workspace";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

describe("Session Search Tools", () => {
  let commandMapper: CommandMapper;
  let testWorkspace: Awaited<ReturnType<typeof createTemporaryTestWorkspace>>;
  let sessionPath: string;

  beforeEach(async () => {
    // Create test workspace and session
    testWorkspace = await createTemporaryTestWorkspace();
    sessionPath = join(testWorkspace.path, "sessions", "test-session");
    await mkdir(sessionPath, { recursive: true });

    // Create test files for searching
    await createTestFiles(sessionPath);

    // Set up command mapper with mock server
    const mockServer = createMockMCPServer();
    const projectContext = createTestProjectContext(testWorkspace.path);
    commandMapper = new CommandMapper(mockServer, projectContext);

    // Register search tools
    registerSessionSearchTools(commandMapper);
  });

  afterEach(async () => {
    await testWorkspace.cleanup();
  });

  describe("session_grep_search", () => {
    it("should find text matches in session files", async () => {
      const result = await commandMapper.callTool("session_grep_search", {
        session: "test-session",
        query: "DatabaseConnection",
      });

      expect(result.success).toBe(true);
      expect(result.results).toContain("DatabaseConnection");
      expect(result.totalMatches).toBeGreaterThan(0);
    });

    it("should support case-sensitive search", async () => {
      const caseSensitiveResult = await commandMapper.callTool("session_grep_search", {
        session: "test-session", 
        query: "DATABASECONNECTION",
        case_sensitive: true,
      });

      const caseInsensitiveResult = await commandMapper.callTool("session_grep_search", {
        session: "test-session",
        query: "DATABASECONNECTION", 
        case_sensitive: false,
      });

      expect(caseSensitiveResult.totalMatches).toBe(0);
      expect(caseInsensitiveResult.totalMatches).toBeGreaterThan(0);
    });

    it("should support include/exclude patterns", async () => {
      const result = await commandMapper.callTool("session_grep_search", {
        session: "test-session",
        query: "function",
        include_pattern: "*.ts",
        exclude_pattern: "*.test.ts",
      });

      expect(result.success).toBe(true);
      expect(result.results).not.toContain("test.ts");
    });

    it("should limit results to 50 matches", async () => {
      const result = await commandMapper.callTool("session_grep_search", {
        session: "test-session",
        query: ".*", // Match everything
      });

      expect(result.success).toBe(true);
      expect(result.totalMatches).toBeLessThanOrEqual(50);
    });
  });

  describe("session_file_search", () => {
    it("should find files by name", async () => {
      const result = await commandMapper.callTool("session_file_search", {
        session: "test-session",
        query: "database",
      });

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toContain("database.ts");
    });

    it("should support fuzzy matching", async () => {
      const result = await commandMapper.callTool("session_file_search", {
        session: "test-session",
        query: "dtbs", // Fuzzy match for "database"
      });

      expect(result.success).toBe(true);
      expect(result.results.length).toBeGreaterThan(0);
    });

    it("should limit results to 10 files", async () => {
      // Create many files to test limit
      for (let i = 0; i < 20; i++) {
        await writeFile(join(sessionPath, `test-file-${i}.ts`), `// Test file ${i}`);
      }

      const result = await commandMapper.callTool("session_file_search", {
        session: "test-session",
        query: "test",
      });

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(10);
      expect(result.totalResults).toBeGreaterThan(10);
      expect(result.message).toContain("first 10 results");
    });
  });

  describe("session_codebase_search", () => {
    it("should perform semantic search", async () => {
      const result = await commandMapper.callTool("session_codebase_search", {
        session: "test-session",
        query: "error handling",
      });

      expect(result.success).toBe(true);
      expect(result.results).toContain("try");
      expect(result.totalMatches).toBeGreaterThan(0);
    });

    it("should support target directories", async () => {
      // Create subdirectory with files
      const subDir = join(sessionPath, "utils");
      await mkdir(subDir, { recursive: true });
      await writeFile(join(subDir, "helper.ts"), "export function validate() { return true; }");

      const result = await commandMapper.callTool("session_codebase_search", {
        session: "test-session",
        query: "validation",
        target_directories: ["utils/*"],
      });

      expect(result.success).toBe(true);
      expect(result.results).toContain("validate");
    });

    it("should expand semantic queries", async () => {
      const result = await commandMapper.callTool("session_codebase_search", {
        session: "test-session",
        query: "database connection",
      });

      expect(result.success).toBe(true);
      expect(result.results).toContain("DatabaseConnection");
    });
  });

  describe("error handling", () => {
    it("should handle invalid session", async () => {
      const result = await commandMapper.callTool("session_grep_search", {
        session: "nonexistent-session",
        query: "test",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("session");
    });

    it("should handle empty queries gracefully", async () => {
      const result = await commandMapper.callTool("session_file_search", {
        session: "test-session",
        query: "",
      });

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(0);
    });
  });
});

/**
 * Create test files for search operations
 */
async function createTestFiles(sessionPath: string): Promise<void> {
  // Main database file
  await writeFile(
    join(sessionPath, "database.ts"),
    `export class DatabaseConnection {
  private connection: any;
  
  async connect(): Promise<void> {
    try {
      this.connection = await this.createConnection();
    } catch (error) {
      throw new Error("Failed to connect to database");
    }
  }
  
  async disconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.close();
    }
  }
  
  private async createConnection(): Promise<any> {
    // Connection logic here
    return {};
  }
}`
  );

  // Utility file
  await writeFile(
    join(sessionPath, "utils.ts"),
    `export function validateInput(input: string): boolean {
  if (!input || input.trim().length === 0) {
    return false;
  }
  return true;
}

export function formatError(error: Error): string {
  return \`Error: \${error.message}\`;
}

export function logDebug(message: string): void {
  console.log(\`[DEBUG] \${message}\`);
}`
  );

  // Configuration file
  await writeFile(
    join(sessionPath, "config.ts"),
    `export interface DatabaseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

export const defaultConfig: DatabaseConfig = {
  host: "localhost",
  port: 5432,
  username: "admin",
  password: "secret",
};

export function loadConfig(): DatabaseConfig {
  // Load configuration from environment or file
  return defaultConfig;
}`
  );

  // Test file
  await writeFile(
    join(sessionPath, "database.test.ts"),
    `import { DatabaseConnection } from "./database";

describe("DatabaseConnection", () => {
  it("should connect successfully", async () => {
    const db = new DatabaseConnection();
    await expect(db.connect()).resolves.not.toThrow();
  });
  
  it("should handle connection errors", async () => {
    const db = new DatabaseConnection();
    // Mock connection failure
    await expect(db.connect()).rejects.toThrow("Failed to connect");
  });
});`
  );
} 
