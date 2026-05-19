/**
 * Tests for performSetup — the domain function behind `minsky setup`.
 *
 * Covers the round-trip regression introduced in mt#1939:
 * `minsky setup --client <X>` previously wrote `harness: <X>` as a **root key**
 * in `.minsky/config.local.yaml`, which was then rejected by the strict
 * config-schema validator on any subsequent CLI invocation.
 *
 * The fix: `harness` is now written under `workspace.harness`, which is a
 * recognised field in `workspaceConfigSchema`.
 */

import { describe, test, expect } from "bun:test";
import { parse as yamlParse } from "yaml";
import { setupTestMocks } from "../utils/test-utils/mocking";
import { createMockFilesystem } from "../utils/test-utils/filesystem/mock-filesystem";
import { performSetup } from "./setup";
import { workspaceConfigSchema } from "./configuration/schemas";
import type { FsLike } from "./interfaces/fs-like";

setupTestMocks();

// Minimal .minsky/config.yaml content — performSetup only needs the `mcp` block
// (defaulting to stdio transport when absent), so a tiny stub is sufficient.
const MINIMAL_PROJECT_CONFIG = `
mcp:
  transport: stdio
`;

const REPO_PATH = "/mock/repo";
const CONFIG_YAML_PATH = `${REPO_PATH}/.minsky/config.yaml`;

/**
 * Return type for makeMockFs: the FsLike interface passed to performSetup,
 * plus a readFileSync accessor for test assertions (no raw internal Map exposure).
 */
type MockFsHandle = FsLike & {
  /** Read a written file back as UTF-8 text — throws ENOENT if absent. */
  readFileSync(path: string, encoding: BufferEncoding): string;
  /** Remove a file from the mock store (for simulating missing-file scenarios). */
  deleteFile(path: string): void;
};

/**
 * Build a mock filesystem pre-populated with the minimal project config.
 * The mock filesystem automatically satisfies the `FsLike` interface used
 * by `performSetup` (async `exists`, `readFile`, `writeFile`, `mkdir`).
 *
 * Assertions on written files use `mockFs.readFileSync(path, "utf-8")` rather
 * than accessing internal Map state, so the tests are not coupled to mock
 * implementation details.
 */
function makeMockFs(): MockFsHandle {
  const mockFs = createMockFilesystem({ [CONFIG_YAML_PATH]: MINIMAL_PROJECT_CONFIG });
  // Build an object that satisfies FsLike using plain async wrappers (not createMock
  // wrappers, which return `void | T` and cause assignability errors).
  const fsLike: FsLike = {
    exists: (p: string) => Promise.resolve(mockFs.existsSync(p) as boolean),
    readFile: (p: string, _enc: BufferEncoding) => {
      if (!mockFs.existsSync(p)) return Promise.reject(new Error(`ENOENT: ${p}`));
      return Promise.resolve(mockFs.readFileSync(p, "utf-8") as string);
    },
    writeFile: (p: string, data: string) => {
      mockFs.writeFileSync(p, data);
      return Promise.resolve();
    },
    mkdir: (p: string, opts?: { recursive?: boolean }) => {
      mockFs.mkdirSync(p, opts);
      return Promise.resolve(undefined);
    },
    readdir: (p: string) => Promise.resolve(mockFs.readdirSync(p) as string[]),
    stat: (p: string) =>
      Promise.resolve(mockFs.statSync(p) as import("./interfaces/fs-like").FsStats),
    access: (p: string) => {
      if (!mockFs.existsSync(p)) return Promise.reject(new Error(`ENOENT: ${p}`));
      return Promise.resolve();
    },
    unlink: (_p: string) => Promise.resolve(),
    copyFile: (_src: string, _dest: string) => Promise.resolve(),
    rm: (_p: string, _opts?: { recursive?: boolean; force?: boolean }) => Promise.resolve(),
  };
  return Object.assign(fsLike, {
    readFileSync: (path: string, encoding: BufferEncoding) =>
      mockFs.readFileSync(path, encoding) as string,
    deleteFile: (path: string) => mockFs.files.delete(path),
  });
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Read the written config.local.yaml content from the mock filesystem and
 * parse it as YAML.  Uses `readFileSync` (an exposed public API) rather than
 * accessing the internal Map directly.
 */
function readLocalConfig(mockHandle: MockFsHandle): Record<string, unknown> {
  const localConfigPath = `${REPO_PATH}/.minsky/config.local.yaml`;
  let raw: string;
  try {
    raw = mockHandle.readFileSync(localConfigPath, "utf-8");
  } catch {
    throw new Error(`config.local.yaml not written to ${localConfigPath}`);
  }
  return yamlParse(raw) as Record<string, unknown>;
}

// ─── schema round-trip tests ─────────────────────────────────────────────────

describe("performSetup — config.local.yaml schema round-trip (mt#1939)", () => {
  const clients = ["cursor", "claude-desktop", "codex", "vscode"] as const;

  for (const client of clients) {
    test(`--client ${client}: written YAML workspace section is accepted by workspaceConfigSchema`, async () => {
      const mockFs = makeMockFs();
      await performSetup({ repoPath: REPO_PATH, client, overwrite: true }, mockFs);

      // config.local.yaml only contains the workspace overlay — validate that
      // sub-object against workspaceConfigSchema rather than the full root schema
      // (which accepts any partial config because all its fields are optional).
      const parsed = readLocalConfig(mockFs);
      const result = workspaceConfigSchema.safeParse(parsed.workspace);

      expect(result.success).toBe(true);
      if (!result.success) {
        // Surface the actual validation error to help diagnose failures
        const issues = result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("\n");
        throw new Error(`workspace config validation failed for client=${client}:\n${issues}`);
      }
    });

    test(`--client ${client}: harness is written under workspace.harness, not at root`, async () => {
      const mockFs = makeMockFs();
      await performSetup({ repoPath: REPO_PATH, client, overwrite: true }, mockFs);

      const parsed = readLocalConfig(mockFs);

      // Root-level `harness` key must be absent
      expect(Object.keys(parsed)).not.toContain("harness");

      // workspace.harness must carry the client value
      const workspace = parsed.workspace as Record<string, unknown> | undefined;
      expect(workspace).toBeDefined();
      expect(workspace?.harness).toBe(client);
    });
  }
});

describe("performSetup — baseline behaviour", () => {
  test("writes workspace.mainPath to the repo path", async () => {
    const mockFs = makeMockFs();
    await performSetup({ repoPath: REPO_PATH, client: "cursor", overwrite: true }, mockFs);

    const parsed = readLocalConfig(mockFs);
    const workspace = parsed.workspace as Record<string, unknown> | undefined;
    expect(workspace?.mainPath).toBe(REPO_PATH);
  });

  test("returns success with localConfigPath and client", async () => {
    const mockFs = makeMockFs();
    const result = await performSetup(
      { repoPath: REPO_PATH, client: "cursor", overwrite: true },
      mockFs
    );

    expect(result.success).toBe(true);
    expect(result.localConfigPath).toBe(`${REPO_PATH}/.minsky/config.local.yaml`);
    expect(result.client).toBe("cursor");
  });

  test("throws when .minsky/config.yaml does not exist", async () => {
    const mockFs = makeMockFs();
    // Remove the project config so the guard fires
    mockFs.deleteFile(CONFIG_YAML_PATH);

    await expect(
      performSetup({ repoPath: REPO_PATH, client: "cursor", overwrite: true }, mockFs)
    ).rejects.toThrow("No .minsky/config.yaml found");
  });
});
