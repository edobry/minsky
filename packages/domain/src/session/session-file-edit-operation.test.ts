/**
 * Domain-level unit tests for applySessionFileEditOperation (mt#2612).
 *
 * Exercises every branch of the canonical apply-model decision logic against
 * real temp-dir filesystems, with a deterministic injected fake for
 * `applyEditPattern` (project convention: `mock.module()` is banned outside
 * `tests/setup.ts` — DI is the canonical seam, per the `no-global-module-mocks`
 * ESLint rule).
 */
import { describe, test, expect } from "bun:test";
import { join } from "path";
// This suite exercises real filesystem behavior deliberately (write/read/exists
// across the FAIL-CLOSED and dry-run branches) — it mirrors the "real handler"
// pattern established in tests/adapters/mcp/session-edit-tools.test.ts.
// eslint-disable-next-line custom/no-real-fs-in-tests
import { mkdtemp, writeFile as fsWriteFile, readFile as fsReadFile, rm, access } from "fs/promises";
// eslint-disable-next-line custom/no-real-fs-in-tests
import { tmpdir } from "os";
import {
  applySessionFileEditOperation,
  detectSuspiciousCollapse,
} from "./session-file-edit-operation";
import type { SessionProviderInterface } from "./index";

function buildSessionProvider(workspaceDir: string): SessionProviderInterface {
  return {
    getSession: async () => ({
      session: "test-session",
      repoName: "test-repo",
      repoUrl: "file:///test",
      backendType: "github" as const,
      createdAt: new Date().toISOString(),
    }),
    getRepoPath: async () => workspaceDir,
  } as unknown as SessionProviderInterface;
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function makeLines(n: number, label = "line"): string {
  return `${Array.from({ length: n }, (_, i) => `${label} ${i}`).join("\n")}\n`;
}

describe("applySessionFileEditOperation", () => {
  describe("new file", () => {
    test("marker-less content creates the file directly", async () => {
      await withWorkspace("sfe-new-", async (workspaceDir) => {
        const sessionProvider = buildSessionProvider(workspaceDir);
        const content = "export const fresh = true;\n";

        const result = await applySessionFileEditOperation({
          sessionId: "test-session",
          path: "brand-new.ts",
          content,
          sessionProvider,
        });

        expect(result.fileExisted).toBe(false);
        expect(result.wrote).toBe(true);
        expect(result.finalContent).toBe(content);
        expect(result.originalContent).toBe("");

        const actual = await fsReadFile(join(workspaceDir, "brand-new.ts"), "utf8");
        expect(actual).toBe(content);
      });
    });

    test("marker content against a non-existent file is refused", async () => {
      await withWorkspace("sfe-new-markers-", async (workspaceDir) => {
        const sessionProvider = buildSessionProvider(workspaceDir);

        await expect(
          applySessionFileEditOperation({
            sessionId: "test-session",
            path: "does-not-exist.ts",
            content: "// ... existing code ...\nnew line\n// ... existing code ...",
            sessionProvider,
          })
        ).rejects.toThrow("Cannot apply edits with existing code markers to non-existent file");

        expect(await fileExists(join(workspaceDir, "does-not-exist.ts"))).toBe(false);
      });
    });
  });

  describe("existing file", () => {
    test("marker content applies the edit pattern via the injected applyEditPattern", async () => {
      await withWorkspace("sfe-existing-markers-", async (workspaceDir) => {
        const sessionProvider = buildSessionProvider(workspaceDir);
        const filePath = join(workspaceDir, "existing.ts");
        const originalContent = "function greet() {\n  return 'old';\n}\n";
        await fsWriteFile(filePath, originalContent, "utf8");

        const appliedContent = "function greet() {\n  return 'new';\n}\n";
        let capturedArgs: [string, string, string | undefined] | undefined;
        const fakeApplyEditPattern = async (
          original: string,
          edit: string,
          instruction?: string
        ): Promise<string> => {
          capturedArgs = [original, edit, instruction];
          return appliedContent;
        };

        const editContent = "// ... existing code ...\n  return 'new';\n// ... existing code ...";
        const result = await applySessionFileEditOperation(
          {
            sessionId: "test-session",
            path: "existing.ts",
            content: editContent,
            instructions: "update greeting",
            sessionProvider,
          },
          { applyEditPattern: fakeApplyEditPattern }
        );

        expect(capturedArgs).toEqual([originalContent, editContent, "update greeting"]);
        expect(result.fileExisted).toBe(true);
        expect(result.wrote).toBe(true);
        expect(result.finalContent).toBe(appliedContent);

        const actual = await fsReadFile(filePath, "utf8");
        expect(actual).toBe(appliedContent);
      });
    });

    test("mt#2400 FAIL-CLOSED: marker-less content is refused and leaves the file intact", async () => {
      await withWorkspace("sfe-failclosed-", async (workspaceDir) => {
        const sessionProvider = buildSessionProvider(workspaceDir);
        const filePath = join(workspaceDir, "existing.ts");
        const originalContent = "export const KEEP = 1;\n";
        await fsWriteFile(filePath, originalContent, "utf8");

        await expect(
          applySessionFileEditOperation({
            sessionId: "test-session",
            path: "existing.ts",
            content: "export const REPLACED = 2;\n",
            sessionProvider,
          })
        ).rejects.toThrow('Refusing to apply marker-less content to existing file "existing.ts"');

        const actual = await fsReadFile(filePath, "utf8");
        expect(actual).toBe(originalContent);
      });
    });

    test("fullReplace=true overrides the FAIL-CLOSED guard", async () => {
      await withWorkspace("sfe-fullreplace-", async (workspaceDir) => {
        const sessionProvider = buildSessionProvider(workspaceDir);
        const filePath = join(workspaceDir, "existing.ts");
        await fsWriteFile(filePath, "old content\n", "utf8");
        const replacement = "brand new content\n";

        const result = await applySessionFileEditOperation({
          sessionId: "test-session",
          path: "existing.ts",
          content: replacement,
          fullReplace: true,
          sessionProvider,
        });

        expect(result.wrote).toBe(true);
        expect(result.finalContent).toBe(replacement);

        const actual = await fsReadFile(filePath, "utf8");
        expect(actual).toBe(replacement);
      });
    });
  });

  describe("dry-run mode", () => {
    test("does not write to disk for a new file", async () => {
      await withWorkspace("sfe-dryrun-new-", async (workspaceDir) => {
        const sessionProvider = buildSessionProvider(workspaceDir);
        const content = "export const willNotExist = true;\n";

        const result = await applySessionFileEditOperation({
          sessionId: "test-session",
          path: "not-written.ts",
          content,
          dryRun: true,
          sessionProvider,
        });

        expect(result.wrote).toBe(false);
        expect(result.finalContent).toBe(content);
        expect(await fileExists(join(workspaceDir, "not-written.ts"))).toBe(false);
      });
    });

    test("does not write to disk for an existing file with fullReplace", async () => {
      await withWorkspace("sfe-dryrun-existing-", async (workspaceDir) => {
        const sessionProvider = buildSessionProvider(workspaceDir);
        const filePath = join(workspaceDir, "existing.ts");
        const originalContent = "original\n";
        await fsWriteFile(filePath, originalContent, "utf8");

        const result = await applySessionFileEditOperation({
          sessionId: "test-session",
          path: "existing.ts",
          content: "replacement\n",
          fullReplace: true,
          dryRun: true,
          sessionProvider,
        });

        expect(result.wrote).toBe(false);
        expect(result.finalContent).toBe("replacement\n");
        const actual = await fsReadFile(filePath, "utf8");
        expect(actual).toBe(originalContent);
      });
    });

    test("still enforces the FAIL-CLOSED guard in dry-run mode", async () => {
      await withWorkspace("sfe-dryrun-failclosed-", async (workspaceDir) => {
        const sessionProvider = buildSessionProvider(workspaceDir);
        const filePath = join(workspaceDir, "existing.ts");
        await fsWriteFile(filePath, "original\n", "utf8");

        await expect(
          applySessionFileEditOperation({
            sessionId: "test-session",
            path: "existing.ts",
            content: "no markers here\n",
            dryRun: true,
            sessionProvider,
          })
        ).rejects.toThrow("Refusing to apply marker-less content");
      });
    });
  });

  describe("createDirs", () => {
    test("creates parent directories when createDirs is true", async () => {
      await withWorkspace("sfe-createdirs-", async (workspaceDir) => {
        const sessionProvider = buildSessionProvider(workspaceDir);
        const content = "nested content\n";

        const result = await applySessionFileEditOperation({
          sessionId: "test-session",
          path: "nested/dir/file.ts",
          content,
          createDirs: true,
          sessionProvider,
        });

        expect(result.wrote).toBe(true);
        const actual = await fsReadFile(join(workspaceDir, "nested/dir/file.ts"), "utf8");
        expect(actual).toBe(content);
      });
    });

    test("without createDirs, writing into a missing directory throws", async () => {
      await withWorkspace("sfe-nocreatedirs-", async (workspaceDir) => {
        const sessionProvider = buildSessionProvider(workspaceDir);

        await expect(
          applySessionFileEditOperation({
            sessionId: "test-session",
            path: "missing/dir/file.ts",
            content: "content\n",
            sessionProvider,
          })
        ).rejects.toThrow();

        expect(await fileExists(join(workspaceDir, "missing/dir/file.ts"))).toBe(false);
      });
    });
  });

  describe("mt#2577 marker-spanning-collapse guard", () => {
    const MARKER_EDIT = "// ... existing code ...\n  changed\n// ... existing code ...";

    test("detectSuspiciousCollapse fires on a large drop, is null otherwise", () => {
      expect(detectSuspiciousCollapse(makeLines(999), makeLines(517))).toEqual({
        originalLines: 999,
        finalLines: 517,
      });
      // Size roughly preserved — normal edit.
      expect(detectSuspiciousCollapse(makeLines(999), makeLines(999))).toBeNull();
      // Below the line-count floor — ratio not applied.
      expect(detectSuspiciousCollapse(makeLines(30), makeLines(5))).toBeNull();
      // Boundary: exactly at the ratio is NOT a collapse; one line under is.
      expect(detectSuspiciousCollapse(makeLines(100), makeLines(60))).toBeNull();
      expect(detectSuspiciousCollapse(makeLines(100), makeLines(59))).toEqual({
        originalLines: 100,
        finalLines: 59,
      });
      // Trailing blank-line churn is normalized away — not a collapse (mt#2577 R1).
      expect(detectSuspiciousCollapse(makeLines(100), `${makeLines(100)}\n\n\n\n\n`)).toBeNull();
      expect(detectSuspiciousCollapse(`${makeLines(100)}\n\n\n\n\n`, makeLines(100))).toBeNull();
    });

    test("throws on the 999->517 collapse and leaves the file intact", async () => {
      await withWorkspace("sfe-collapse-", async (workspaceDir) => {
        const sessionProvider = buildSessionProvider(workspaceDir);
        const filePath = join(workspaceDir, "big.ts");
        const originalContent = makeLines(999);
        await fsWriteFile(filePath, originalContent, "utf8");

        // The apply model mis-resolves a marker and collapses 999 -> 517.
        await expect(
          applySessionFileEditOperation(
            {
              sessionId: "test-session",
              path: "big.ts",
              content: MARKER_EDIT,
              sessionProvider,
            },
            { applyEditPattern: async () => makeLines(517) }
          )
        ).rejects.toThrow("marker-spanning-collapse failure (mt#2577)");

        // File must be untouched.
        expect(await fsReadFile(filePath, "utf8")).toBe(originalContent);
      });
    });

    test("a normal marker edit that preserves size is NOT blocked", async () => {
      await withWorkspace("sfe-nocollapse-", async (workspaceDir) => {
        const sessionProvider = buildSessionProvider(workspaceDir);
        const filePath = join(workspaceDir, "big.ts");
        await fsWriteFile(filePath, makeLines(999), "utf8");
        const applied = makeLines(998); // minor change, size ~preserved

        const result = await applySessionFileEditOperation(
          {
            sessionId: "test-session",
            path: "big.ts",
            content: MARKER_EDIT,
            sessionProvider,
          },
          { applyEditPattern: async () => applied }
        );

        expect(result.wrote).toBe(true);
        expect(await fsReadFile(filePath, "utf8")).toBe(applied);
      });
    });

    test("allowShrink=true overrides the guard (intentional large deletion)", async () => {
      await withWorkspace("sfe-allowshrink-", async (workspaceDir) => {
        const sessionProvider = buildSessionProvider(workspaceDir);
        const filePath = join(workspaceDir, "big.ts");
        await fsWriteFile(filePath, makeLines(999), "utf8");
        const applied = makeLines(517);

        const result = await applySessionFileEditOperation(
          {
            sessionId: "test-session",
            path: "big.ts",
            content: MARKER_EDIT,
            allowShrink: true,
            sessionProvider,
          },
          { applyEditPattern: async () => applied }
        );

        expect(result.wrote).toBe(true);
        expect(await fsReadFile(filePath, "utf8")).toBe(applied);
      });
    });

    test("a small file below the line-count floor is NOT blocked", async () => {
      await withWorkspace("sfe-smallfile-", async (workspaceDir) => {
        const sessionProvider = buildSessionProvider(workspaceDir);
        const filePath = join(workspaceDir, "small.ts");
        await fsWriteFile(filePath, makeLines(30), "utf8");
        const applied = makeLines(5); // big ratio drop, but below the floor

        const result = await applySessionFileEditOperation(
          {
            sessionId: "test-session",
            path: "small.ts",
            content: MARKER_EDIT,
            sessionProvider,
          },
          { applyEditPattern: async () => applied }
        );

        expect(result.wrote).toBe(true);
        expect(await fsReadFile(filePath, "utf8")).toBe(applied);
      });
    });

    test("still enforces the collapse guard in dry-run mode", async () => {
      await withWorkspace("sfe-collapse-dryrun-", async (workspaceDir) => {
        const sessionProvider = buildSessionProvider(workspaceDir);
        const filePath = join(workspaceDir, "big.ts");
        const originalContent = makeLines(999);
        await fsWriteFile(filePath, originalContent, "utf8");

        await expect(
          applySessionFileEditOperation(
            {
              sessionId: "test-session",
              path: "big.ts",
              content: MARKER_EDIT,
              dryRun: true,
              sessionProvider,
            },
            { applyEditPattern: async () => makeLines(517) }
          )
        ).rejects.toThrow("marker-spanning-collapse failure (mt#2577)");

        expect(await fsReadFile(filePath, "utf8")).toBe(originalContent);
      });
    });
  });
});
