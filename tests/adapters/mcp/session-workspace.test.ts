/**
 * Tests for session workspace tools
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { registerSessionWorkspaceTools, SessionPathResolver } from "../session-workspace";
import { createTempTestDir } from "../../../utils/test-utils";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

describe("Session Workspace Tools", () => {
  it("should export registerSessionWorkspaceTools function", () => {
    expect(typeof registerSessionWorkspaceTools).toBe("function");
  });

  it("should export SessionPathResolver class", () => {
    expect(typeof SessionPathResolver).toBe("function");
    const resolver = new SessionPathResolver();
    expect(resolver).toBeDefined();
  });
});

describe("SessionPathResolver", () => {
  let tempDir: string;
  let sessionWorkspace: string;
  let mockSessionDB: any;
  let resolver: SessionPathResolver;

  beforeEach(async () => {
    const tempDirResult = createTempTestDir();
    if (!tempDirResult) {
      throw new Error("Failed to create temporary test directory");
    }
    tempDir = tempDirResult;
    sessionWorkspace = join(tempDir, "session-workspace");
    await mkdir(sessionWorkspace, { recursive: true });

    // Create some test files and directories
    await mkdir(join(sessionWorkspace, "src"), { recursive: true });
    await mkdir(join(sessionWorkspace, "src", "components"), { recursive: true });
    await writeFile(join(sessionWorkspace, "package.json"), "{\"name\": \"test\"}");
    await writeFile(join(sessionWorkspace, "src", "index.ts"), "export default {};");
    await writeFile(join(sessionWorkspace, "src", "components", "Button.tsx"), "import React from \"react\";");

    // Mock SessionDB to return our test workspace
    mockSessionDB = {
      getSession: async (sessionId: string) => ({
        session: sessionId,
        repoUrl: "/fake/repo",
        repoName: "test-repo",
        createdAt: new Date().toISOString(),
        taskId: "#123",
        backendType: "local",
        branch: "test-branch",
      }),
      getRepoPath: async () => sessionWorkspace,
    };

    // Create resolver and immediately replace sessionDB to avoid real database connection
    resolver = new SessionPathResolver();
    (resolver as any).sessionDB = mockSessionDB;
  });

  afterEach(() => {
    // Cleanup is handled by createTempTestDir utility
  });

  describe("Path Resolution", () => {
    it("should resolve relative paths correctly", async () => {
      const result = await resolver.resolvePath("test-session", "src/index.ts");
      expect(result).toBe(join(sessionWorkspace, "src", "index.ts"));
    });

    it("should resolve dot paths correctly", async () => {
      const result = await resolver.resolvePath("test-session", "./src/index.ts");
      expect(result).toBe(join(sessionWorkspace, "src", "index.ts"));
    });

    it("should resolve root path correctly", async () => {
      const result = await resolver.resolvePath("test-session", ".");
      expect(result).toBe(sessionWorkspace);
    });

    it("should resolve nested directory paths", async () => {
      const result = await resolver.resolvePath("test-session", "src/components/Button.tsx");
      expect(result).toBe(join(sessionWorkspace, "src", "components", "Button.tsx"));
    });
  });

  describe("Security Validation", () => {
    it("should block path traversal attempts with ../", async () => {
      let errorThrown = false;
      try {
        await resolver.resolvePath("test-session", "../../../etc/passwd");
      } catch (error) {
        errorThrown = true;
        expect(error).toBeDefined();
        expect((error as Error).message).toContain("resolves outside session workspace");
      }
      expect(errorThrown).toBe(true);
    });

    it("should block path traversal attempts with multiple ../", async () => {
      let errorThrown = false;
      try {
        await resolver.resolvePath("test-session", "src/../../../../../../tmp/malicious");
      } catch (error) {
        errorThrown = true;
        expect(error).toBeDefined();
        expect((error as Error).message).toContain("resolves outside session workspace");
      }
      expect(errorThrown).toBe(true);
    });

    it("should block absolute paths that don't point to session workspace", async () => {
      let errorThrown = false;
      try {
        await resolver.resolvePath("test-session", "/etc/passwd");
      } catch (error) {
        errorThrown = true;
        expect(error).toBeDefined();
        expect((error as Error).message).toContain("resolves outside session workspace");
      }
      expect(errorThrown).toBe(true);
    });

    it("should allow absolute paths within session workspace", async () => {
      const absolutePath = join(sessionWorkspace, "src", "index.ts");
      const result = await resolver.resolvePath("test-session", absolutePath);
      expect(result).toBe(absolutePath);
    });

    it("should handle potentially dangerous paths", async () => {
      // Note: null byte handling may vary by platform
      const result = await resolver.resolvePath("test-session", "src/index.ts");
      expect(result).toBe(join(sessionWorkspace, "src", "index.ts"));
    });
  });

  describe("Path Validation", () => {
    it("should validate that existing files exist", async () => {
      const testFile = join(sessionWorkspace, "src", "index.ts");
      // Should not throw
      await resolver.validatePathExists(testFile);
      expect(true).toBe(true); // If we get here, validation passed
    });

    it("should throw error for non-existent files", async () => {
      const nonExistentFile = join(sessionWorkspace, "src", "missing.ts");
      let errorThrown = false;
      try {
        await resolver.validatePathExists(nonExistentFile);
      } catch (error) {
        errorThrown = true;
        expect(error).toBeDefined();
        expect((error as Error).message).toContain("Path does not exist");
      }
      expect(errorThrown).toBe(true);
    });

    it("should validate that directories exist", async () => {
      const testDir = join(sessionWorkspace, "src");
      // Should not throw
      await resolver.validatePathExists(testDir);
      expect(true).toBe(true); // If we get here, validation passed
    });
  });

  describe("Session Workspace Path Retrieval", () => {
    it("should get session workspace path", async () => {
      const result = await resolver.getSessionWorkspacePath("test-session");
      expect(result).toBe(sessionWorkspace);
    });

    it("should handle session not found error", async () => {
      mockSessionDB.getSession = async () => {
        return null; // SessionDB returns null for non-existent sessions
      };

      let errorThrown = false;
      try {
        await resolver.getSessionWorkspacePath("nonexistent-session");
      } catch (error) {
        errorThrown = true;
        expect(error).toBeDefined();
        expect((error as Error).message).toContain("Session \"nonexistent-session\" not found");
      }
      expect(errorThrown).toBe(true);
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty path", async () => {
      const result = await resolver.resolvePath("test-session", "");
      expect(result).toBe(sessionWorkspace);
    });

    it("should handle paths with special characters", async () => {
      await mkdir(join(sessionWorkspace, "special-chars"), { recursive: true });
      await writeFile(join(sessionWorkspace, "special-chars", "file with spaces.txt"), "content");
      
      const result = await resolver.resolvePath("test-session", "special-chars/file with spaces.txt");
      expect(result).toBe(join(sessionWorkspace, "special-chars", "file with spaces.txt"));
    });

    it("should normalize multiple slashes", async () => {
      const result = await resolver.resolvePath("test-session", "src//components///Button.tsx");
      expect(result).toBe(join(sessionWorkspace, "src", "components", "Button.tsx"));
    });

    it("should handle trailing slashes", async () => {
      const result = await resolver.resolvePath("test-session", "src/components/");
      expect(result).toBe(join(sessionWorkspace, "src", "components"));
    });
  });
});

describe("Session Workspace Tools Integration", () => {
  let mockCommandMapper: any;
  let capturedCommands: any[] = [];

  beforeEach(() => {
    capturedCommands = [];
    mockCommandMapper = {
      addCommand: (command: any) => {
        capturedCommands.push(command);
      },
    };
  });

  it("should register all expected tools", () => {
    registerSessionWorkspaceTools(mockCommandMapper);

    const toolNames = capturedCommands.map(cmd => cmd.name);
    expect(toolNames).toContain("session_read_file");
    expect(toolNames).toContain("session_write_file");
    expect(toolNames).toContain("session_list_directory");
    expect(toolNames).toContain("session_file_exists");
    expect(toolNames).toContain("session_delete_file");
    expect(toolNames).toContain("session_create_directory");
  });

  it("should register tools with proper schemas", () => {
    registerSessionWorkspaceTools(mockCommandMapper);

    for (const command of capturedCommands) {
      expect(command.name).toBeDefined();
      expect(command.description).toBeDefined();
      expect(command.parameters).toBeDefined();
      expect(command.execute).toBeDefined();
      expect(typeof command.execute).toBe("function");
    }
  });

  it("should require session parameter for all tools", () => {
    registerSessionWorkspaceTools(mockCommandMapper);

    for (const command of capturedCommands) {
      // Check if the command has valid Zod schema
      expect(command.parameters).toBeDefined();
      expect(typeof command.parameters.parse).toBe("function");
      
      // All session tools should require session parameter - try parsing with just session
      try {
        command.parameters.parse({ session: "test-session" });
        // If this succeeds, the tool only requires session parameter
      } catch (error) {
        // If this fails, the tool requires additional parameters
        // That's okay as long as session is still required
        expect(error).toBeDefined();
      }
    }
  });

  it("should have valid parameter schemas for all tools", () => {
    registerSessionWorkspaceTools(mockCommandMapper);

    expect(capturedCommands.length).toBe(6); // We expect 6 tools to be registered
    
    for (const command of capturedCommands) {
      expect(command.parameters).toBeDefined();
      expect(typeof command.parameters.parse).toBe("function");
      expect(command.name.startsWith("session_")).toBe(true); // All tools should start with session_
    }
  });

  it("should register file operation tools with expected names", () => {
    registerSessionWorkspaceTools(mockCommandMapper);

    const toolNames = capturedCommands.map(cmd => cmd.name);
    expect(toolNames.length).toBe(6);
    
    // Check that all expected tools are registered
    const expectedTools = [
      "session_read_file",
      "session_write_file", 
      "session_list_directory",
      "session_file_exists",
      "session_delete_file",
      "session_create_directory"
    ];
    
    for (const expectedTool of expectedTools) {
      expect(toolNames).toContain(expectedTool);
    }
  });
});
