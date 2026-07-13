/**
 * Golden equivalence tests (mt#2612): the CLI command (`session.edit-file`,
 * `createSessionEditFileCommand`) and the MCP tool (`session.edit_file`,
 * `registerSessionEditTools`) must now delegate to the same canonical
 * `applySessionFileEditOperation` domain function. These tests exercise the
 * REAL entry points (not mocks of them) side by side against real temp-dir
 * filesystems, for every non-AI branch, and assert byte-identical resulting
 * file content and identical underlying error text.
 *
 * Mirrors the "real handler" pattern in
 * tests/adapters/mcp/session-edit-tools.test.ts (mt#2400 fail-closed guard).
 */
import { describe, test, expect } from "bun:test";
import { join } from "path";
// Real fs is deliberate here — this suite proves both real entry points
// produce byte-identical on-disk results, which cannot be verified with mocks.
// eslint-disable-next-line custom/no-real-fs-in-tests
import { mkdtemp, writeFile as fsWriteFile, readFile as fsReadFile, rm } from "fs/promises";
// eslint-disable-next-line custom/no-real-fs-in-tests
import { tmpdir } from "os";

import { createSessionEditFileCommand } from "../../../../../src/adapters/shared/commands/session/file-commands";
import type { SessionCommandDependencies } from "../../../../../src/adapters/shared/commands/session/types";
import { registerSessionEditTools } from "../../../../../src/adapters/mcp/session-edit-tools";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function buildMockSessionProvider(workspaceDir: string) {
  return {
    getSession: async () => ({
      session: "test-session",
      repoName: "test-repo",
      repoUrl: "file:///test",
      backendType: "github" as const,
      createdAt: new Date().toISOString(),
    }),
    getRepoPath: async () => workspaceDir,
  } as unknown as import("@minsky/domain/session").SessionProviderInterface;
}

async function withWorkspace(
  prefix: string,
  fn: (workspaceDir: string) => Promise<void>
): Promise<void> {
  const workspaceDir = await mkdtemp(join(tmpdir(), prefix));
  try {
    await fn(workspaceDir);
  } finally {
    // eslint-disable-next-line custom/no-real-fs-in-tests
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

/**
 * Run the REAL CLI command's execute() against a temp workspace. Bypasses
 * arg parsing (this exercises the command's business logic, same as calling
 * the MCP handler directly bypasses JSON-RPC dispatch) but is otherwise the
 * genuine `createSessionEditFileCommand` code path.
 */
async function runCliEdit(
  workspaceDir: string,
  params: {
    path: string;
    content: string;
    dryRun?: boolean;
    createDirs?: boolean;
    fullReplace?: boolean;
  }
): Promise<{ success: boolean; error?: string; result?: Record<string, unknown> }> {
  const patternFilePath = join(workspaceDir, `.pattern-${Math.random().toString(36).slice(2)}`);
  await fsWriteFile(patternFilePath, params.content, "utf8");

  const deps = {
    sessionProvider: buildMockSessionProvider(workspaceDir),
    getCurrentSession: async () => "test-session",
  } as unknown as SessionCommandDependencies;

  const command = createSessionEditFileCommand(() => Promise.resolve(deps));

  try {
    const result = (await command.execute(
      {
        session: "test-session",
        path: params.path,
        instruction: "equivalence test",
        patternFile: patternFilePath,
        dryRun: params.dryRun ?? false,
        createDirs: params.createDirs ?? false,
        fullReplace: params.fullReplace ?? false,
        json: true,
      },
      {}
    )) as Record<string, unknown>;
    return { success: true, result };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Run the REAL MCP tool handler against a temp workspace.
 */
async function runMcpEdit(
  workspaceDir: string,
  params: {
    path: string;
    content: string;
    dryRun?: boolean;
    createDirs?: boolean;
    fullReplace?: boolean;
  }
): Promise<{ success: boolean; error?: string; result?: Record<string, unknown> }> {
  const container = {
    has: (key: string) => key === "sessionProvider",
    get: (key: string) => {
      if (key === "sessionProvider") return buildMockSessionProvider(workspaceDir);
      throw new Error(`Unknown service: ${key}`);
    },
  } as unknown as import("@minsky/domain/composition/types").AppContainerInterface;

  const tools: Record<string, { getHandler: () => Promise<(args: unknown) => Promise<any>> }> = {};
  const commandMapper = {
    addCommand: (cmd: {
      name: string;
      getHandler: () => Promise<(args: unknown) => Promise<any>>;
    }) => {
      tools[cmd.name] = cmd;
    },
  };
  registerSessionEditTools(commandMapper as any, container);
  const tool = tools["session.edit_file"];
  if (!tool) {
    throw new Error("session.edit_file tool was not registered");
  }
  const handler = await tool.getHandler();

  const result = (await handler({
    sessionId: "test-session",
    path: params.path,
    instructions: "equivalence test",
    content: params.content,
    dryRun: params.dryRun ?? false,
    createDirs: params.createDirs ?? false,
    fullReplace: params.fullReplace ?? false,
  })) as Record<string, unknown>;

  if (result.success === false) {
    return { success: false, error: String(result.error) };
  }
  return { success: true, result };
}

// ---------------------------------------------------------------------------
// Golden equivalence tests
// ---------------------------------------------------------------------------

describe("session.edit-file (CLI) vs session.edit_file (MCP) — golden equivalence (mt#2612)", () => {
  test("new-file creation produces byte-identical content via both entry points", async () => {
    const content = "export const fresh = true;\n";

    await withWorkspace("equiv-new-cli-", async (cliWorkspace) => {
      const cliOutcome = await runCliEdit(cliWorkspace, { path: "new-file.ts", content });
      expect(cliOutcome.success).toBe(true);
      const cliFileContent = await fsReadFile(join(cliWorkspace, "new-file.ts"), "utf8");
      expect(cliFileContent).toBe(content);

      await withWorkspace("equiv-new-mcp-", async (mcpWorkspace) => {
        const mcpOutcome = await runMcpEdit(mcpWorkspace, { path: "new-file.ts", content });
        expect(mcpOutcome.success).toBe(true);
        const mcpFileContent = await fsReadFile(join(mcpWorkspace, "new-file.ts"), "utf8");
        expect(mcpFileContent).toBe(content);

        // Byte-identical across both entry points.
        expect(mcpFileContent).toBe(cliFileContent);
      });
    });
  });

  test("mt#2400 FAIL-CLOSED: marker-less content on an existing file is refused via BOTH entry points", async () => {
    const originalContent = "export function keepMe() {\n  return 1;\n}\n";
    const attemptedReplacement = "export const ONLY = 3;\n";

    await withWorkspace("equiv-failclosed-cli-", async (cliWorkspace) => {
      const filePath = join(cliWorkspace, "existing.ts");
      await fsWriteFile(filePath, originalContent, "utf8");

      const cliOutcome = await runCliEdit(cliWorkspace, {
        path: "existing.ts",
        content: attemptedReplacement,
      });
      expect(cliOutcome.success).toBe(false);
      expect(cliOutcome.error).toContain("marker-less content");
      // File untouched.
      expect(await fsReadFile(filePath, "utf8")).toBe(originalContent);

      await withWorkspace("equiv-failclosed-mcp-", async (mcpWorkspace) => {
        const mcpFilePath = join(mcpWorkspace, "existing.ts");
        await fsWriteFile(mcpFilePath, originalContent, "utf8");

        const mcpOutcome = await runMcpEdit(mcpWorkspace, {
          path: "existing.ts",
          content: attemptedReplacement,
        });
        expect(mcpOutcome.success).toBe(false);
        expect(mcpOutcome.error).toContain("marker-less content");
        // File untouched.
        expect(await fsReadFile(mcpFilePath, "utf8")).toBe(originalContent);

        // Identical underlying refusal text (CLI wraps with "Failed to edit
        // file: <message>"; strip that wrapper before comparing).
        const cliCoreMessage = (cliOutcome.error ?? "").replace(/^Failed to edit file: /, "");
        expect(cliCoreMessage).toBe(mcpOutcome.error ?? "");
      });
    });
  });

  test("fullReplace=true overrides the FAIL-CLOSED guard identically via both entry points", async () => {
    const originalContent = "old content\nmore old content\n";
    const replacement = "brand new content\n";

    await withWorkspace("equiv-fullreplace-cli-", async (cliWorkspace) => {
      const filePath = join(cliWorkspace, "existing.ts");
      await fsWriteFile(filePath, originalContent, "utf8");

      const cliOutcome = await runCliEdit(cliWorkspace, {
        path: "existing.ts",
        content: replacement,
        fullReplace: true,
      });
      expect(cliOutcome.success).toBe(true);
      const cliFileContent = await fsReadFile(filePath, "utf8");
      expect(cliFileContent).toBe(replacement);

      await withWorkspace("equiv-fullreplace-mcp-", async (mcpWorkspace) => {
        const mcpFilePath = join(mcpWorkspace, "existing.ts");
        await fsWriteFile(mcpFilePath, originalContent, "utf8");

        const mcpOutcome = await runMcpEdit(mcpWorkspace, {
          path: "existing.ts",
          content: replacement,
          fullReplace: true,
        });
        expect(mcpOutcome.success).toBe(true);
        const mcpFileContent = await fsReadFile(mcpFilePath, "utf8");
        expect(mcpFileContent).toBe(replacement);

        expect(mcpFileContent).toBe(cliFileContent);
      });
    });
  });

  test("marker content against a non-existent file is refused identically via both entry points", async () => {
    const editPattern = "// ... existing code ...\nnew line\n// ... existing code ...";

    await withWorkspace("equiv-nomarker-file-cli-", async (cliWorkspace) => {
      const cliOutcome = await runCliEdit(cliWorkspace, {
        path: "does-not-exist.ts",
        content: editPattern,
      });
      expect(cliOutcome.success).toBe(false);
      expect(cliOutcome.error).toContain(
        "Cannot apply edits with existing code markers to non-existent file"
      );

      await withWorkspace("equiv-nomarker-file-mcp-", async (mcpWorkspace) => {
        const mcpOutcome = await runMcpEdit(mcpWorkspace, {
          path: "does-not-exist.ts",
          content: editPattern,
        });
        expect(mcpOutcome.success).toBe(false);
        expect(mcpOutcome.error).toContain(
          "Cannot apply edits with existing code markers to non-existent file"
        );

        const cliCoreMessage = (cliOutcome.error ?? "").replace(/^Failed to edit file: /, "");
        expect(cliCoreMessage).toBe(mcpOutcome.error ?? "");
      });
    });
  });

  test("createDirs=true creates nested directories identically via both entry points", async () => {
    const nestedPath = "nested/dir/file.ts";
    const content = "nested content\n";

    await withWorkspace("equiv-createdirs-cli-", async (cliWorkspace) => {
      const cliOutcome = await runCliEdit(cliWorkspace, {
        path: nestedPath,
        content,
        createDirs: true,
      });
      expect(cliOutcome.success).toBe(true);
      const cliFileContent = await fsReadFile(join(cliWorkspace, nestedPath), "utf8");
      expect(cliFileContent).toBe(content);

      await withWorkspace("equiv-createdirs-mcp-", async (mcpWorkspace) => {
        const mcpOutcome = await runMcpEdit(mcpWorkspace, {
          path: nestedPath,
          content,
          createDirs: true,
        });
        expect(mcpOutcome.success).toBe(true);
        const mcpFileContent = await fsReadFile(join(mcpWorkspace, nestedPath), "utf8");
        expect(mcpFileContent).toBe(content);

        expect(mcpFileContent).toBe(cliFileContent);
      });
    });
  });
});
