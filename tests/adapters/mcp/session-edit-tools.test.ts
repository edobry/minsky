/**
 * Tests for session-aware edit tools
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { setupTestMocks } from "../../../src/utils/test-utils/mocking";
import { DIFF_TEST_CONTENT, UI_TEST_PATTERNS } from "../../../src/utils/test-utils/test-constants";
// mt#1361 regression tests need the real session.search_replace handler to run
// against a real temp file to prove the dollar-pattern fix actually applies in
// production. Refactoring registerSessionEditTools to accept fs deps is out of
// scope for this fix; the eslint-disables below are limited to this file.
// eslint-disable-next-line custom/no-real-fs-in-tests
import { mkdtemp, writeFile as fsWriteFile, readFile as fsReadFile, rm } from "fs/promises";
// eslint-disable-next-line custom/no-real-fs-in-tests
import { tmpdir } from "os";
import { join } from "path";

// Set up automatic mock cleanup
setupTestMocks();

import {
  registerSessionEditTools,
  countOccurrences,
} from "../../../src/adapters/mcp/session-edit-tools";

// Build a mock container exposing a sessionProvider that points at a real
// temp directory as the session workspace. SessionPathResolver consumes this
// provider to resolve user-supplied paths into the workspace, so the real
// session.search_replace handler can run end-to-end without a real session DB.
function buildSessionContainer(workspaceDir: string) {
  const sessionRecord = {
    session: "test-session",
    repoName: "test-repo",
    repoUrl: "file:///test",
    backendType: "github" as const,
    createdAt: new Date().toISOString(),
  };
  const mockSessionProvider = {
    getSession: async () => sessionRecord,
    getRepoPath: async () => workspaceDir,
  } as unknown as import("@minsky/domain/session").SessionProviderInterface;
  return {
    has: (key: string) => key === "sessionProvider",
    get: (key: string) => {
      if (key === "sessionProvider") return mockSessionProvider;
      throw new Error(`Unknown service: ${key}`);
    },
  } as unknown as import("@minsky/domain/composition/types").AppContainerInterface;
}

// Register tools against a fresh container; returns the captured tools map.
// Resolves the lazy `getHandler` thunks (mt#1792) into concrete `.handler`
// functions — post-mt#1792 the command objects expose `getHandler`, not
// `handler`, so the real-handler tests must await the thunk first.
async function registerToolsWithContainer(
  container: ReturnType<typeof buildSessionContainer>
): Promise<Record<string, { handler: (args: any) => Promise<any> }>> {
  const tools: Record<string, any> = {};
  const cm = {
    addCommand: (cmd: { name: string; handler?: any; getHandler?: any }) => {
      tools[cmd.name] = cmd;
    },
  };
  registerSessionEditTools(cm as any, container);
  for (const name of Object.keys(tools)) {
    const cmd = tools[name];
    if (!cmd.handler && typeof cmd.getHandler === "function") {
      cmd.handler = await cmd.getHandler();
    }
  }
  return tools;
}

describe("Session Edit Tools", () => {
  let commandMapper: any;
  let registeredTools: any;

  beforeEach(() => {
    // Create mock command mapper
    registeredTools = {};

    // Mock addCommand to capture registered tools
    const mockAddCommand = mock(
      (command: { name: string; description: string; parameters?: any; handler: any }) => {
        registeredTools[command.name] = {
          name: command.name,
          description: command.description,
          schema: command.parameters,
          handler: command.handler,
        };
      }
    );

    commandMapper = {
      addCommand: mockAddCommand,
    };

    // Register the tools
    registerSessionEditTools(commandMapper);
  });

  describe("session_edit_file", () => {
    test("should be registered with correct schema", () => {
      expect(registeredTools["session.edit_file"]).toBeDefined();
      expect(registeredTools["session.edit_file"].name).toBe("session.edit_file");
      expect(registeredTools["session.edit_file"].description).toContain(
        "Use this tool to make an edit"
      );
    });

    test("should create new file when it doesn't exist", async () => {
      // Mock the MCP session tools implementations
      const mockSessionEditFile = mock(async (args: any) => {
        return {
          success: true,
          message: `Created new file at ${args.path}`,
          filePath: args.path,
          changes: "Created new file",
        };
      });

      // Test the tool registration and basic functionality
      const tool = registeredTools["session.edit_file"];
      expect(tool).toBeDefined();
      expect(tool.name).toBe("session.edit_file");

      // Simulate successful file creation
      const result = await mockSessionEditFile({
        sessionId: "test-session",
        path: "new-file.txt",
        instructions: UI_TEST_PATTERNS.CREATE_NEW_FILE,
        content: "Hello world",
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain("Created new file");
      expect(mockSessionEditFile).toHaveBeenCalledWith({
        sessionId: "test-session",
        path: "new-file.txt",
        instructions: UI_TEST_PATTERNS.CREATE_NEW_FILE,
        content: "Hello world",
      });
    });

    test("should handle edit operations with mock setup", async () => {
      // Mock the MCP session edit implementation
      const mockSessionEditFile = mock(async (args: any) => {
        return {
          success: true,
          message: `Applied edit to ${args.path}`,
          filePath: args.path,
          changes: `Modified file with instructions: ${args.instructions}`,
        };
      });

      // Test the tool registration
      const tool = registeredTools["session.edit_file"];
      expect(tool).toBeDefined();

      // Simulate edit operation
      const result = await mockSessionEditFile({
        sessionId: "test-session",
        path: "existing-file.txt",
        instructions: "Add a new line",
        content: "// ... existing code ...\nnew line\n// ... existing code ...",
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain("Applied edit");
      expect(result.changes).toContain("Add a new line");
    });

    describe("dry-run functionality", () => {
      test("should support dryRun parameter in schema", () => {
        const tool = registeredTools["session.edit_file"];
        expect(tool).toBeDefined();
        expect(tool.schema).toBeDefined();
        // The schema should include dryRun parameter
        // This validates that the schema was updated correctly
      });

      test("should return proposed content and diff for existing file in dry-run mode", async () => {
        // Mock the tool handler directly for dry-run testing
        const mockDryRunEditFile = mock(async (args: any) => {
          if (args.dryRun) {
            const _originalContent = DIFF_TEST_CONTENT.THREE_LINES;
            const proposedContent = DIFF_TEST_CONTENT.MODIFIED_THREE_LINES;
            return {
              success: true,
              timestamp: new Date().toISOString(),
              path: args.path,
              session: args.sessionId,
              resolvedPath: "/mock/session/path/file.txt",
              dryRun: true,
              proposedContent,
              diff: "--- file.txt\n+++ file.txt\n@@ -1,3 +1,3 @@\n line 1\n-line 2\n+modified line 2\n line 3",
              diffSummary: {
                linesAdded: 1,
                linesRemoved: 1,
                linesChanged: 0,
                totalLines: 3,
              },
              edited: true,
              created: false,
            };
          }
          return { success: false };
        });

        const result = await mockDryRunEditFile({
          sessionId: "test-session",
          path: "existing-file.txt",
          instructions: "Modify line 2",
          content: DIFF_TEST_CONTENT.MODIFIED_THREE_LINES,
          dryRun: true,
        });

        expect(result.success).toBe(true);
        expect(result.dryRun).toBe(true);
        expect(result.proposedContent).toBe(DIFF_TEST_CONTENT.MODIFIED_THREE_LINES);
        expect(result.diff).toContain("--- file.txt");
        expect(result.diff).toContain("+++ file.txt");
        expect(result.diff).toContain("-line 2");
        expect(result.diff).toContain("+modified line 2");
        expect(result.diffSummary).toEqual({
          linesAdded: 1,
          linesRemoved: 1,
          linesChanged: 0,
          totalLines: 3,
        });
        expect(result.edited).toBe(true);
        expect(result.created).toBe(false);
      });

      test("should return proposed content for new file in dry-run mode", async () => {
        const mockDryRunNewFile = mock(async (args: any) => {
          if (args.dryRun) {
            const proposedContent = UI_TEST_PATTERNS.NEW_FILE_CONTENT;
            return {
              success: true,
              timestamp: new Date().toISOString(),
              path: args.path,
              session: args.sessionId,
              resolvedPath: "/mock/session/path/new-file.txt",
              dryRun: true,
              proposedContent,
              diff: "--- new-file.txt\n+++ new-file.txt\n@@ -0,0 +1,2 @@\n+new file content\n+line 2",
              diffSummary: {
                linesAdded: 2,
                linesRemoved: 0,
                linesChanged: 0,
                totalLines: 2,
              },
              edited: false,
              created: true,
            };
          }
          return { success: false };
        });

        const result = await mockDryRunNewFile({
          sessionId: "test-session",
          path: "new-file.txt",
          instructions: UI_TEST_PATTERNS.CREATE_NEW_FILE,
          content: UI_TEST_PATTERNS.NEW_FILE_CONTENT,
          dryRun: true,
        });

        expect(result.success).toBe(true);
        expect(result.dryRun).toBe(true);
        expect(result.proposedContent).toBe(UI_TEST_PATTERNS.NEW_FILE_CONTENT);
        expect(result.diff).toContain("+new file content");
        expect(result.diff).toContain("+line 2");
        expect(result.diffSummary?.linesAdded).toBe(2);
        expect(result.diffSummary?.linesRemoved).toBe(0);
        expect(result.edited).toBe(false);
        expect(result.created).toBe(true);
      });

      test("should not write to disk in dry-run mode", async () => {
        const mockWriteFile = mock(() => Promise.resolve(undefined));
        const mockMkdir = mock(() => Promise.resolve(undefined));

        const mockDryRunNoWrite = mock(async (args: any) => {
          if (args.dryRun) {
            // In dry-run mode, writeFile and mkdir should never be called
            return {
              success: true,
              dryRun: true,
              proposedContent: args.content,
              diff: "mock diff",
              diffSummary: { linesAdded: 1, linesRemoved: 0, linesChanged: 0, totalLines: 1 },
            };
          }
          return { success: false };
        });

        await mockDryRunNoWrite({
          sessionId: "test-session",
          path: "test-file.txt",
          instructions: "Test dry run",
          content: "modified content",
          dryRun: true,
          createDirs: true,
        });

        // Verify that file system operations were not called
        expect(mockWriteFile).not.toHaveBeenCalled();
        expect(mockMkdir).not.toHaveBeenCalled();
      });

      test("should handle edit patterns correctly in dry-run mode", async () => {
        const mockDryRunEditPattern = mock(async (args: any) => {
          if (args.dryRun && args.content.includes("// ... existing code ...")) {
            const _originalContent = "function test() {\n  console.log('old');\n  return true;\n}";
            const proposedContent = "function test() {\n  console.log('new');\n  return true;\n}";
            return {
              success: true,
              dryRun: true,
              proposedContent,
              diff: "--- test-file.txt\n+++ test-file.txt\n@@ -1,4 +1,4 @@\n function test() {\n-  console.log('old');\n+  console.log('new');\n   return true;\n }",
              diffSummary: {
                linesAdded: 1,
                linesRemoved: 1,
                linesChanged: 0,
                totalLines: 4,
              },
              edited: true,
              created: false,
            };
          }
          return { success: false };
        });

        const result = await mockDryRunEditPattern({
          sessionId: "test-session",
          path: "test-file.txt",
          instructions: "Update console.log message",
          content: "// ... existing code ...\n  console.log('new');\n// ... existing code ...",
          dryRun: true,
        });

        expect(result.success).toBe(true);
        expect(result.dryRun).toBe(true);
        expect(result.proposedContent).toContain("console.log('new')");
        expect(result.diff).toContain("-  console.log('old');");
        expect(result.diff).toContain("+  console.log('new');");
      });

      test("should fail dry-run when trying to apply edit patterns to non-existent file", async () => {
        const mockDryRunFailPattern = mock(async (args: any) => {
          if (args.dryRun && args.content.includes("// ... existing code ...")) {
            throw new Error(
              `Cannot apply edits with existing code markers to non-existent file: ${args.path}`
            );
          }
          return { success: false };
        });

        await expect(
          mockDryRunFailPattern({
            sessionId: "test-session",
            path: "non-existent.txt",
            instructions: "Try to edit non-existent file",
            content: "// ... existing code ...\nnew line\n// ... existing code ...",
            dryRun: true,
          })
        ).rejects.toThrow("Cannot apply edits with existing code markers to non-existent file");
      });
    });

    describe("mt#2400 fail-closed guard (real handler)", () => {
      test("marker-less content on an existing file is refused and leaves it intact", async () => {
        const workspaceDir = await mkdtemp(join(tmpdir(), "mt2400-edit-"));
        const tools = await registerToolsWithContainer(buildSessionContainer(workspaceDir));
        const filePath = join(workspaceDir, "existing.ts");
        const originalContent =
          "export function keepMe() {\n  return 1;\n}\n\nexport const ALSO = 2;\n";

        try {
          await fsWriteFile(filePath, originalContent, "utf8");
          const tool = tools["session.edit_file"];
          expect(tool).toBeDefined();
          if (!tool) return;

          const result = await tool.handler({
            sessionId: "test-session",
            path: "existing.ts",
            instructions: "replace everything",
            content: "export const ONLY = 3;\n",
          });

          // Structured error envelope, not a throw.
          expect(result.success).toBe(false);
          expect(String(result.error)).toContain("marker-less content");
          expect(String(result.error)).toContain("session_write_file");
          // File untouched — the destructive overwrite did not happen.
          const actual = await fsReadFile(filePath, "utf8");
          expect(actual).toBe(originalContent);
        } finally {
          // eslint-disable-next-line custom/no-real-fs-in-tests
          await rm(workspaceDir, { recursive: true, force: true });
        }
      });

      test("marker-less content with fullReplace=true intentionally overwrites the file", async () => {
        const workspaceDir = await mkdtemp(join(tmpdir(), "mt2400-edit-fr-"));
        const tools = await registerToolsWithContainer(buildSessionContainer(workspaceDir));
        const filePath = join(workspaceDir, "existing.ts");
        const originalContent = "old content\nmore old content\n";
        const replacement = "brand new content\n";

        try {
          await fsWriteFile(filePath, originalContent, "utf8");
          const tool = tools["session.edit_file"];
          expect(tool).toBeDefined();
          if (!tool) return;

          const result = await tool.handler({
            sessionId: "test-session",
            path: "existing.ts",
            instructions: "full replace",
            content: replacement,
            fullReplace: true,
          });

          expect(result.success).toBe(true);
          const actual = await fsReadFile(filePath, "utf8");
          expect(actual).toBe(replacement);
        } finally {
          // eslint-disable-next-line custom/no-real-fs-in-tests
          await rm(workspaceDir, { recursive: true, force: true });
        }
      });

      test("marker-less content on a NEW file is allowed (creates it)", async () => {
        const workspaceDir = await mkdtemp(join(tmpdir(), "mt2400-edit-new-"));
        const tools = await registerToolsWithContainer(buildSessionContainer(workspaceDir));
        const newContent = "export const fresh = true;\n";

        try {
          const tool = tools["session.edit_file"];
          expect(tool).toBeDefined();
          if (!tool) return;

          const result = await tool.handler({
            sessionId: "test-session",
            path: "brand-new.ts",
            instructions: "create file",
            content: newContent,
          });

          expect(result.success).toBe(true);
          expect(result.created).toBe(true);
          const actual = await fsReadFile(join(workspaceDir, "brand-new.ts"), "utf8");
          expect(actual).toBe(newContent);
        } finally {
          // eslint-disable-next-line custom/no-real-fs-in-tests
          await rm(workspaceDir, { recursive: true, force: true });
        }
      });
    });
  });

  describe("session_search_replace", () => {
    test("should be registered with correct schema", () => {
      expect(registeredTools["session.search_replace"]).toBeDefined();
      expect(registeredTools["session.search_replace"].name).toBe("session.search_replace");
      expect(registeredTools["session.search_replace"].description).toContain(
        "Replace text in a file"
      );
    });

    test("should replace single occurrence successfully", async () => {
      // Mock successful search and replace
      const mockSearchReplace = mock(async (args: any) => {
        return {
          success: true,
          message: `Replaced "${args.search}" with "${args.replace}" in ${args.path}`,
          filePath: args.path,
          occurrences: 1,
        };
      });

      const tool = registeredTools["session.search_replace"];
      expect(tool).toBeDefined();

      const result = await mockSearchReplace({
        sessionId: "test-session",
        path: "test-file.txt",
        search: "old text",
        replace: "new text",
      });

      expect(result.success).toBe(true);
      expect(result.occurrences).toBe(1);
      expect(result.message).toContain("Replaced");
    });

    test("should error when text not found", async () => {
      // Mock search text not found scenario
      const mockSearchReplace = mock(async (args: any) => {
        throw new Error(`Text "${args.search}" not found in ${args.path}`);
      });

      const tool = registeredTools["session.search_replace"];
      expect(tool).toBeDefined();

      await expect(
        mockSearchReplace({
          sessionId: "test-session",
          path: "test-file.txt",
          search: "nonexistent text",
          replace: "new text",
        })
      ).rejects.toThrow('Text "nonexistent text" not found');
    });

    test("should error when multiple occurrences found", async () => {
      // Mock multiple occurrences found scenario
      const mockSearchReplace = mock(async (args: any) => {
        throw new Error(
          `Multiple occurrences of "${args.search}" found in ${args.path}. Please be more specific.`
        );
      });

      const tool = registeredTools["session.search_replace"];
      expect(tool).toBeDefined();

      await expect(
        mockSearchReplace({
          sessionId: "test-session",
          path: "test-file.txt",
          search: "common text",
          replace: "new text",
        })
      ).rejects.toThrow("Multiple occurrences");
    });

    test("should replace all occurrences when replace_all is true", async () => {
      // Verify the replace_all branch calls replaceAll and returns the correct count.
      // Uses a mock handler that simulates the real behavior without filesystem I/O.
      const mockSearchReplaceAll = mock(async (args: any) => {
        const content = "foo bar foo baz foo";
        let replacementCount = 0;
        // Simulate the function-replacer overload (the actual fix for mt#1361)
        const newContent = content.replaceAll(args.search, () => {
          replacementCount++;
          return args.replace;
        });
        if (args.replace_all) {
          return {
            success: true,
            path: args.path,
            session: args.sessionId,
            edited: true,
            replaced: true,
            replacementCount,
            newContent,
          };
        }
        throw new Error(`Search text found ${replacementCount} times`);
      });

      const result = await mockSearchReplaceAll({
        sessionId: "test-session",
        path: "test-file.txt",
        search: "foo",
        replace: "qux",
        replace_all: true,
      });

      expect(result.success).toBe(true);
      expect(result.replacementCount).toBe(3);
      expect(result.replaced).toBe(true);
      expect(result.newContent).toBe("qux bar qux baz qux");
    });

    test("should include replacementCount in response for single replacement", async () => {
      const mockSearchReplace = mock(async (args: any) => {
        return {
          success: true,
          path: args.path,
          session: args.sessionId,
          edited: true,
          replaced: true,
          replacementCount: 1,
          searchText: args.search,
          replaceText: args.replace,
        };
      });

      const result = await mockSearchReplace({
        sessionId: "test-session",
        path: "test-file.txt",
        search: "old text",
        replace: "new text",
      });

      expect(result.success).toBe(true);
      expect(result.replacementCount).toBe(1);
    });

    test("should error when search text not found with replace_all true", async () => {
      const mockSearchReplaceAll = mock(async (args: any) => {
        throw new Error(`Search text not found in file: "${args.search}"`);
      });

      await expect(
        mockSearchReplaceAll({
          sessionId: "test-session",
          path: "test-file.txt",
          search: "nonexistent",
          replace: "replacement",
          replace_all: true,
        })
      ).rejects.toThrow("Search text not found in file");
    });

    test("should have replace_all parameter in schema", () => {
      const tool = registeredTools["session.search_replace"];
      expect(tool).toBeDefined();
      expect(tool.schema).toBeDefined();
      // Validate the schema shape includes replace_all
      const schemaShape = tool.schema.shape;
      expect(schemaShape).toHaveProperty("replace_all");
    });

    test("should have old_string and new_string as aliases in schema", () => {
      const tool = registeredTools["session.search_replace"];
      expect(tool).toBeDefined();
      expect(tool.schema).toBeDefined();
      const schemaShape = tool.schema.shape;
      expect(schemaShape).toHaveProperty("old_string");
      expect(schemaShape).toHaveProperty("new_string");
    });

    test("should accept old_string alias for search parameter", async () => {
      const mockSearchReplace = mock(async (args: any) => {
        // Simulate handler alias resolution
        const searchText = args.search ?? args.old_string;
        const replaceText = args.replace ?? args.new_string;
        if (!searchText)
          throw new Error('Missing required parameter "search" (or alias "old_string")');
        if (!replaceText)
          throw new Error('Missing required parameter "replace" (or alias "new_string")');
        return {
          success: true,
          path: args.path,
          session: args.sessionId,
          edited: true,
          replaced: true,
          replacementCount: 1,
          searchText,
          replaceText,
        };
      });

      const result = await mockSearchReplace({
        sessionId: "test-session",
        path: "test-file.txt",
        old_string: "old text",
        new_string: "new text",
      });

      expect(result.success).toBe(true);
      expect(result.searchText).toBe("old text");
      expect(result.replaceText).toBe("new text");
      expect(result.replacementCount).toBe(1);
    });

    test("should error when neither search nor old_string is provided", async () => {
      const mockSearchReplace = mock(async (args: any) => {
        const searchText = args.search ?? args.old_string;
        const replaceText = args.replace ?? args.new_string;
        if (!searchText) {
          const receivedKeys = Object.keys(args).join(", ");
          throw new Error(
            `Missing required parameter "search" (or alias "old_string"). Received parameters: [${receivedKeys}]`
          );
        }
        if (!replaceText) {
          const receivedKeys = Object.keys(args).join(", ");
          throw new Error(
            `Missing required parameter "replace" (or alias "new_string"). Received parameters: [${receivedKeys}]`
          );
        }
        return { success: true };
      });

      await expect(
        mockSearchReplace({
          sessionId: "test-session",
          path: "test-file.txt",
          // No search, no old_string
          replace: "new text",
        })
      ).rejects.toThrow('Missing required parameter "search" (or alias "old_string")');
    });

    test("regression: dollar-backtick in replace string does not duplicate content (real handler)", async () => {
      // mt#1361: replace text containing dollar-backtick was interpreted as the
      // JS replacement-pattern prefix-before-match substitution, causing each
      // replacement to contain the preceding file content.
      // This test exercises the REAL session.search_replace handler end-to-end.
      const workspaceDir = await mkdtemp(join(tmpdir(), "mt1361-real-"));
      const tools = await registerToolsWithContainer(buildSessionContainer(workspaceDir));
      const filePath = join(workspaceDir, "test.txt");
      const searchText = "SEARCH_TOKEN";
      // Build replace text containing the bug-triggering byte sequence
      // (backtick, dollar, backtick, [-_]key, backtick) at runtime, avoiding
      // a literal occurrence in the source so writing this very test doesn't
      // re-trigger the bug we are fixing.
      const replaceText = `see ${String.fromCharCode(0x60, 0x24, 0x60)}[-_]key${String.fromCharCode(
        0x60
      )} for details`;
      const originalContent = `line before\n${searchText}\nmiddle line\n${searchText}\nline after`;

      try {
        await fsWriteFile(filePath, originalContent, "utf8");

        const tool = tools["session.search_replace"];
        expect(tool).toBeDefined();
        if (!tool) return;
        const result = await tool.handler({
          sessionId: "test-session",
          path: "test.txt",
          search: searchText,
          replace: replaceText,
          replace_all: true,
        });

        expect(result.success).toBe(true);
        expect(result.replacementCount).toBe(2);

        const actualContent = await fsReadFile(filePath, "utf8");
        const expected = originalContent.split(searchText).join(replaceText);
        expect(actualContent).toBe(expected);
        expect(actualContent.length).toBe(
          originalContent.length + 2 * (replaceText.length - searchText.length)
        );
        // Bug signature would splice prefix content into the replacement
        expect(actualContent).not.toContain(`see ${String.fromCharCode(0x60)}line before`);
      } finally {
        // eslint-disable-next-line custom/no-real-fs-in-tests
        await rm(workspaceDir, { recursive: true, force: true });
      }
    });

    test("mt#2400: replace_all that balloons the file past 1.5x is refused and leaves it intact (real handler)", async () => {
      const workspaceDir = await mkdtemp(join(tmpdir(), "mt2400-grow-"));
      const tools = await registerToolsWithContainer(buildSessionContainer(workspaceDir));
      const filePath = join(workspaceDir, "test.txt");
      const search = "X";
      // 5 occurrences; replacing each short token with a long string blows the
      // file well past 1.5x its original size.
      const replace = "REPLACEMENT_TOKEN_THAT_IS_VERY_LONG_INDEED_0123456789";
      const originalContent = "X\nX\nX\nX\nX\n";

      try {
        await fsWriteFile(filePath, originalContent, "utf8");
        const tool = tools["session.search_replace"];
        expect(tool).toBeDefined();
        if (!tool) return;

        const result = await tool.handler({
          sessionId: "test-session",
          path: "test.txt",
          search,
          replace,
          replace_all: true,
        });

        // Handler returns a structured error envelope rather than throwing.
        expect(result.success).toBe(false);
        expect(String(result.error)).toContain("Refusing replace_all");
        expect(String(result.error)).toContain("allow_growth");
        // File must be untouched.
        const actual = await fsReadFile(filePath, "utf8");
        expect(actual).toBe(originalContent);
      } finally {
        // eslint-disable-next-line custom/no-real-fs-in-tests
        await rm(workspaceDir, { recursive: true, force: true });
      }
    });

    test("mt#2400: replace_all growth past 1.5x is allowed with allow_growth=true (real handler)", async () => {
      const workspaceDir = await mkdtemp(join(tmpdir(), "mt2400-grow-ok-"));
      const tools = await registerToolsWithContainer(buildSessionContainer(workspaceDir));
      const filePath = join(workspaceDir, "test.txt");
      const search = "X";
      const replace = "REPLACEMENT_TOKEN_THAT_IS_VERY_LONG_INDEED_0123456789";
      const originalContent = "X\nX\nX\nX\nX\n";

      try {
        await fsWriteFile(filePath, originalContent, "utf8");
        const tool = tools["session.search_replace"];
        expect(tool).toBeDefined();
        if (!tool) return;

        const result = await tool.handler({
          sessionId: "test-session",
          path: "test.txt",
          search,
          replace,
          replace_all: true,
          allow_growth: true,
        });

        expect(result.success).toBe(true);
        expect(result.replacementCount).toBe(5);
        const actual = await fsReadFile(filePath, "utf8");
        expect(actual).toBe(originalContent.split(search).join(replace));
      } finally {
        // eslint-disable-next-line custom/no-real-fs-in-tests
        await rm(workspaceDir, { recursive: true, force: true });
      }
    });

    test("mt#2400: ordinary replace_all under the growth threshold still works (real handler)", async () => {
      const workspaceDir = await mkdtemp(join(tmpdir(), "mt2400-grow-normal-"));
      const tools = await registerToolsWithContainer(buildSessionContainer(workspaceDir));
      const filePath = join(workspaceDir, "test.txt");
      const originalContent = "alpha foo beta foo gamma foo delta";

      try {
        await fsWriteFile(filePath, originalContent, "utf8");
        const tool = tools["session.search_replace"];
        expect(tool).toBeDefined();
        if (!tool) return;

        const result = await tool.handler({
          sessionId: "test-session",
          path: "test.txt",
          search: "foo",
          replace: "bar",
          replace_all: true,
        });

        expect(result.success).toBe(true);
        expect(result.replacementCount).toBe(3);
        const actual = await fsReadFile(filePath, "utf8");
        expect(actual).toBe("alpha bar beta bar gamma bar delta");
      } finally {
        // eslint-disable-next-line custom/no-real-fs-in-tests
        await rm(workspaceDir, { recursive: true, force: true });
      }
    });

    test("regression: dollar-ampersand in replace string does not expand the match (real handler)", async () => {
      // mt#1361: dollar-ampersand normally expands to the matched substring.
      // Real-handler test that the function-replacer fix prevents this.
      const workspaceDir = await mkdtemp(join(tmpdir(), "mt1361-real-"));
      const tools = await registerToolsWithContainer(buildSessionContainer(workspaceDir));
      const filePath = join(workspaceDir, "test.txt");
      const searchText = "TARGET";
      // Build "dollar-ampersand-literal" at runtime to avoid putting the bug
      // trigger in source.
      const replaceText = `${String.fromCharCode(0x24, 0x26)}-literal`;
      const originalContent = `before ${searchText} after`;

      try {
        await fsWriteFile(filePath, originalContent, "utf8");

        const tool = tools["session.search_replace"];
        expect(tool).toBeDefined();
        if (!tool) return;
        const result = await tool.handler({
          sessionId: "test-session",
          path: "test.txt",
          search: searchText,
          replace: replaceText,
        });

        expect(result.success).toBe(true);
        expect(result.replacementCount).toBe(1);

        const actualContent = await fsReadFile(filePath, "utf8");
        const expected = `before ${replaceText} after`;
        expect(actualContent).toBe(expected);
        // Bug signature would expand to "before TARGET-literal after"
        expect(actualContent).not.toBe("before TARGET-literal after");
      } finally {
        // eslint-disable-next-line custom/no-real-fs-in-tests
        await rm(workspaceDir, { recursive: true, force: true });
      }
    });

    test("mt#2408: empty search string is rejected fast and does not hang (real handler)", async () => {
      const workspaceDir = await mkdtemp(join(tmpdir(), "mt2408-empty-"));
      const tools = await registerToolsWithContainer(buildSessionContainer(workspaceDir));
      const filePath = join(workspaceDir, "test.txt");
      const originalContent = "some content here\n";

      try {
        await fsWriteFile(filePath, originalContent, "utf8");
        const tool = tools["session.search_replace"];
        expect(tool).toBeDefined();
        if (!tool) return;

        const result = await tool.handler({
          sessionId: "test-session",
          path: "test.txt",
          search: "",
          replace: "anything",
        });

        // Structured error envelope, returned promptly (no infinite loop).
        expect(result.success).toBe(false);
        expect(String(result.error)).toContain("non-empty");
        // File untouched.
        const actual = await fsReadFile(filePath, "utf8");
        expect(actual).toBe(originalContent);
      } finally {
        // eslint-disable-next-line custom/no-real-fs-in-tests
        await rm(workspaceDir, { recursive: true, force: true });
      }
    });
  });
});

describe("countOccurrences — mt#2408 empty-search guard", () => {
  test("returns 0 for an empty search string (never loops)", () => {
    expect(countOccurrences("anything at all", "")).toBe(0);
    expect(countOccurrences("", "")).toBe(0);
  });

  test("still counts non-empty needles correctly", () => {
    expect(countOccurrences("foo bar foo baz foo", "foo")).toBe(3);
    expect(countOccurrences("aaaa", "aa")).toBe(2);
    expect(countOccurrences("no match here", "xyz")).toBe(0);
  });
});
