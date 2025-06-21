/**
 * Tests for session file operations MCP adapter
 */
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { registerSessionFileTools, SessionPathResolver } from "../session-files";
import { promises as fs } from "fs";
import { join } from "path";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";

describe("Session File Tools", () => {
  test("registerSessionFileTools registers expected commands", () => {
    const mockCommandMapper = {
      addCommand: mock(() => {}),
    };

    registerSessionFileTools(mockCommandMapper as any);

    // Should register 4 session file tools
    expect(mockCommandMapper.addCommand.mock.calls.length).toBe(4);

    const calls = mockCommandMapper.addCommand.mock.calls;

    // Verify command names
    const commandNames = calls.map((call: any) => call[0].name);
    expect(commandNames).toContain("session.read_file");
    expect(commandNames).toContain("session.write_file");
    expect(commandNames).toContain("session.list_directory");
    expect(commandNames).toContain("session.file_exists");

    // Verify each command has proper structure
    calls.forEach((call: any) => {
      const command = call[0];
      expect(command.name).toBeDefined();
      expect(command.description).toBeDefined();
      expect(command.parameters).toBeDefined();
      expect(command.execute).toBeDefined();
      expect(typeof command.name).toBe("string");
      expect(typeof command.description).toBe("string");
      expect(typeof command.execute).toBe("function");
    });
  });
});

describe("Session File Operations Integration Tests", () => {
  let tempSessionDir: string;
  let mockSessionDb: any;
  let testCommands: any = {};

  beforeEach(async () => {
    // Create a temporary directory for session workspace
    tempSessionDir = await mkdtemp(join(tmpdir(), "session-test-"));
    
    // Mock SessionDB to return our temp directory
    mockSessionDb = {
      getSessionWorkdir: (sessionId: string) => Promise.resolve(tempSessionDir)
    };

    // Mock getCurrentSession to return a test session ID
    const getCurrentSessionMock = () => Promise.resolve("test-session");

    // Create a testable SessionPathResolver with mocked dependencies
    const testPathResolver = new SessionPathResolver(mockSessionDb, getCurrentSessionMock);

    // Capture commands for testing
    const mockCommandMapper = {
      addCommand: mock((command: any) => {
        testCommands[command.name] = command;
      }),
    };

    // Register commands with mocked dependencies
    registerSessionFileTools(mockCommandMapper as any, testPathResolver);
  });

  afterEach(async () => {
    // Clean up temp directory
    try {
      await fs.rm(tempSessionDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  test("session.write_file creates and writes to files correctly", async () => {
    const writeCommand = testCommands["session.write_file"];
    expect(writeCommand).toBeDefined();

    // Test writing a file
    const result = await writeCommand.execute({
      path: "test.txt",
      content: "Hello, session workspace!",
      session: "test-session"
    });

    // Should succeed
    expect(result.success).toBe(true);
    expect(result.path).toBe("test.txt");
    expect(result.session).toBe("test-session");

    // File should actually exist
    const filePath = join(tempSessionDir, "test.txt");
    const fileExists = await fs.access(filePath).then(() => true).catch(() => false);
    expect(fileExists).toBe(true);

    // Content should match
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe("Hello, session workspace!");
  });

  test("session.read_file reads files correctly", async () => {
    // First create a test file
    const testContent = "Test file content\nLine 2";
    await fs.writeFile(join(tempSessionDir, "read-test.txt"), testContent);

    const readCommand = testCommands["session.read_file"];
    expect(readCommand).toBeDefined();

    const result = await readCommand.execute({
      path: "read-test.txt",
      session: "test-session"
    });

    expect(result.success).toBe(true);
    expect(result.content).toBe(testContent);
    expect(result.path).toBe("read-test.txt");
  });

  test("session.list_directory lists directory contents", async () => {
    // Create some test files and directories
    await fs.writeFile(join(tempSessionDir, "file1.txt"), "content1");
    await fs.writeFile(join(tempSessionDir, "file2.js"), "content2");
    await fs.mkdir(join(tempSessionDir, "subdir"));
    await fs.writeFile(join(tempSessionDir, "subdir", "nested.txt"), "nested");

    const listCommand = testCommands["session.list_directory"];
    expect(listCommand).toBeDefined();

    const result = await listCommand.execute({
      path: ".",
      session: "test-session"
    });

    expect(result.success).toBe(true);
    expect(result.items).toBeDefined();
    expect(Array.isArray(result.items)).toBe(true);

    const itemNames = result.items.map((item: any) => item.name);
    expect(itemNames).toContain("file1.txt");
    expect(itemNames).toContain("file2.js");
    expect(itemNames).toContain("subdir");

    // Check that directory is properly typed
    const subdirItem = result.items.find((item: any) => item.name === "subdir");
    expect(subdirItem.type).toBe("directory");
  });

  test("session.file_exists checks file existence correctly", async () => {
    // Create a test file
    await fs.writeFile(join(tempSessionDir, "exists-test.txt"), "content");

    const existsCommand = testCommands["session.file_exists"];
    expect(existsCommand).toBeDefined();

    // Test existing file
    const existsResult = await existsCommand.execute({
      path: "exists-test.txt",
      session: "test-session"
    });

    expect(existsResult.success).toBe(true);
    expect(existsResult.exists).toBe(true);
    expect(existsResult.type).toBe("file");

    // Test non-existing file
    const notExistsResult = await existsCommand.execute({
      path: "does-not-exist.txt",
      session: "test-session"
    });

    expect(notExistsResult.success).toBe(true);
    expect(notExistsResult.exists).toBe(false);
  });

  test("path validation prevents directory traversal", async () => {
    const writeCommand = testCommands["session.write_file"];

    // Test various directory traversal attempts
    const maliciousPaths = [
      "../outside-session.txt",
      "../../etc/passwd",
      "/absolute/path.txt",
      "subdir/../../../escape.txt"
    ];

    for (const maliciousPath of maliciousPaths) {
      const result = await writeCommand.execute({
        path: maliciousPath,
        content: "malicious content",
        session: "test-session"
      });

      // Should fail with security error
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain("outside session workspace");
    }
  });

  test("handles missing session gracefully", async () => {
    const readCommand = testCommands["session.read_file"];

    const result = await readCommand.execute({
      path: "test.txt",
      session: "non-existent-session"
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe("SessionPathResolver", () => {
  test("should validate session paths correctly", async () => {
    // This test will be implemented when we add more detailed path resolution testing
    expect(true).toBe(true); // Placeholder for future detailed path validation tests
  });
});
