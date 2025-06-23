/**
 * Test suite for session-aware command execution tools
 * Validates compatibility with Cursor's command execution interface
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { CommandMapper } from "../../../mcp/command-mapper.js";
import { registerSessionCommandTools } from "../session-command-tools.js";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { createUniqueTestDir } from "../../../utils/test-helpers.js";

describe("Session Command Tools", () => {
  let commandMapper: CommandMapper;
  let mockSessionId: string;
  let mockSessionPath: string;

  beforeEach(async () => {
    commandMapper = new CommandMapper();
    registerSessionCommandTools(commandMapper);
    
    const mockSession = await createMockSession("command-tools-test");
    mockSessionId = mockSession.sessionId;
    mockSessionPath = mockSession.sessionPath;
  });

  afterEach(async () => {
    await cleanupMockSession(mockSessionId);
  });

  describe("session_run_command", () => {
    test("executes basic commands successfully", async () => {
      const result = await commandMapper.invoke("session_run_command", {
        session: mockSessionId,
        command: "echo 'test command execution'",
        is_background: false,
      });

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("test command execution");
      expect(result.output).toContain("Exit code: 0");
      expect(result.output).toContain("Command completed.");
      expect(result.output).toContain("The previous shell command ended");
    });

    test("handles command chaining correctly", async () => {
      const result = await commandMapper.invoke("session_run_command", {
        session: mockSessionId,
        command: "echo 'line1' && echo 'line2'",
        is_background: false,
      });

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("line1");
      expect(result.output).toContain("line2");
    });

    test("reports correct exit codes for failed commands", async () => {
      const result = await commandMapper.invoke("session_run_command", {
        session: mockSessionId,
        command: "exit 1",
        is_background: false,
      });

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Exit code: 1");
    });

    test("handles non-existent commands", async () => {
      const result = await commandMapper.invoke("session_run_command", {
        session: mockSessionId,
        command: "nonexistent-command-test-123",
        is_background: false,
      });

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(127);
      expect(result.output).toContain("command not found");
    });

    test("executes commands in session workspace directory", async () => {
      const result = await commandMapper.invoke("session_run_command", {
        session: mockSessionId,
        command: "pwd",
        is_background: false,
      });

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain(mockSessionPath);
    });

    test("handles background process execution", async () => {
      const result = await commandMapper.invoke("session_run_command", {
        session: mockSessionId,
        command: "sleep 10",
        is_background: true,
      });

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Background process started with PID");
    });

    test("validates session boundaries", async () => {
      const result = await commandMapper.invoke("session_run_command", {
        session: "non-existent-session",
        command: "echo test",
        is_background: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Session");
    });
  });

  describe("session_list_dir", () => {
    beforeEach(async () => {
      // Create test directory structure
      await mkdir(join(mockSessionPath, "test-dir"), { recursive: true });
      await writeFile(join(mockSessionPath, "test-file.txt"), "test content\nline 2\nline 3");
      await writeFile(join(mockSessionPath, "test-dir", "nested-file.js"), "console.log('test');");
    });

    test("lists directory contents with correct formatting", async () => {
      const result = await commandMapper.invoke("session_list_dir", {
        session: mockSessionId,
        relative_workspace_path: ".",
      });

      expect(result.success).toBe(true);
      expect(result.contents).toContain("Contents of directory:");
      expect(result.contents).toContain("[dir]  test-dir/ (1 items)");
      expect(result.contents).toContain("[file] test-file.txt");
      expect(result.contents).toContain("3 lines");
    });

    test("lists nested directory contents", async () => {
      const result = await commandMapper.invoke("session_list_dir", {
        session: mockSessionId,
        relative_workspace_path: "test-dir",
      });

      expect(result.success).toBe(true);
      expect(result.contents).toContain("nested-file.js");
      expect(result.contents).toContain("[file]");
    });

    test("handles empty directories", async () => {
      await mkdir(join(mockSessionPath, "empty-dir"));
      
      const result = await commandMapper.invoke("session_list_dir", {
        session: mockSessionId,
        relative_workspace_path: "empty-dir",
      });

      expect(result.success).toBe(true);
      expect(result.contents).toContain("Contents of directory:");
      expect(result.itemCount).toBe(0);
    });

    test("validates session boundaries", async () => {
      const result = await commandMapper.invoke("session_list_dir", {
        session: mockSessionId,
        relative_workspace_path: "../../..",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("outside session workspace");
    });

    test("handles non-existent directories", async () => {
      const result = await commandMapper.invoke("session_list_dir", {
        session: mockSessionId,
        relative_workspace_path: "non-existent-directory",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("ENOENT");
    });
  });

  describe("session_read_file", () => {
    beforeEach(async () => {
      // Create test files
      const longContent = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}: test content`).join("\n");
      await writeFile(join(mockSessionPath, "test-file.txt"), "Hello World\nSecond Line\nThird Line");
      await writeFile(join(mockSessionPath, "long-file.txt"), longContent);
    });

    test("reads entire file when requested", async () => {
      const result = await commandMapper.invoke("session_read_file", {
        session: mockSessionId,
        target_file: "test-file.txt",
        should_read_entire_file: true,
        start_line_one_indexed: 1,
        end_line_one_indexed_inclusive: 10,
      });

      expect(result.success).toBe(true);
      expect(result.content).toContain("Contents of test-file.txt:");
      expect(result.content).toContain("Hello World");
      expect(result.content).toContain("Second Line");
      expect(result.content).toContain("Third Line");
      expect(result.totalLines).toBe(3);
    });

    test("reads specific line range when requested", async () => {
      const result = await commandMapper.invoke("session_read_file", {
        session: mockSessionId,
        target_file: "long-file.txt",
        should_read_entire_file: false,
        start_line_one_indexed: 5,
        end_line_one_indexed_inclusive: 10,
      });

      expect(result.success).toBe(true);
      expect(result.content).toContain("lines 5-10 (total 20 lines):");
      expect(result.content).toContain("Line 5: test content");
      expect(result.content).toContain("Line 10: test content");
      expect(result.content).toContain("Lines 1-4 not shown");
      expect(result.content).toContain("Lines 11-20 not shown");
    });

    test("handles line range at file boundaries", async () => {
      const result = await commandMapper.invoke("session_read_file", {
        session: mockSessionId,
        target_file: "test-file.txt",
        should_read_entire_file: false,
        start_line_one_indexed: 1,
        end_line_one_indexed_inclusive: 3,
      });

      expect(result.success).toBe(true);
      expect(result.content).toContain("Hello World");
      expect(result.content).not.toContain("not shown");
    });

    test("validates session boundaries", async () => {
      const result = await commandMapper.invoke("session_read_file", {
        session: mockSessionId,
        target_file: "../../etc/passwd",
        should_read_entire_file: true,
        start_line_one_indexed: 1,
        end_line_one_indexed_inclusive: 10,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("outside session workspace");
    });

    test("handles non-existent files", async () => {
      const result = await commandMapper.invoke("session_read_file", {
        session: mockSessionId,
        target_file: "non-existent-file.txt",
        should_read_entire_file: true,
        start_line_one_indexed: 1,
        end_line_one_indexed_inclusive: 10,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("ENOENT");
    });
  });

  describe("Tool Registration", () => {
    test("registers all command tools successfully", () => {
      const toolNames = commandMapper.getRegisteredToolNames();
      
      expect(toolNames).toContain("session_run_command");
      expect(toolNames).toContain("session_list_dir");
      expect(toolNames).toContain("session_read_file");
    });

    test("tools have correct interface schemas", () => {
      const runCommandTool = commandMapper.getTool("session_run_command");
      const listDirTool = commandMapper.getTool("session_list_dir");
      const readFileTool = commandMapper.getTool("session_read_file");

      expect(runCommandTool).toBeDefined();
      expect(listDirTool).toBeDefined();
      expect(readFileTool).toBeDefined();

      // Verify parameter schemas match Cursor's interface
      expect(runCommandTool?.inputSchema.shape.session).toBeDefined();
      expect(runCommandTool?.inputSchema.shape.command).toBeDefined();
      expect(runCommandTool?.inputSchema.shape.is_background).toBeDefined();

      expect(listDirTool?.inputSchema.shape.session).toBeDefined();
      expect(listDirTool?.inputSchema.shape.relative_workspace_path).toBeDefined();

      expect(readFileTool?.inputSchema.shape.session).toBeDefined();
      expect(readFileTool?.inputSchema.shape.target_file).toBeDefined();
      expect(readFileTool?.inputSchema.shape.should_read_entire_file).toBeDefined();
      expect(readFileTool?.inputSchema.shape.start_line_one_indexed).toBeDefined();
      expect(readFileTool?.inputSchema.shape.end_line_one_indexed_inclusive).toBeDefined();
    });
  });
}); 
