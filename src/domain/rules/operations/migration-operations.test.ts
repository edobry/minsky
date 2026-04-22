/**
 * Unit tests for migrateRules — in-memory fake fs.
 *
 * Covers the 5 scenarios required by mt#1090:
 *  1. Dry-run makes no filesystem writes and reports what would be done
 *  2. Real run copies .cursor/rules/*.mdc to .minsky/rules/*.mdc preserving content
 *  3. --force overwrites existing target files
 *  4. Without --force, refuses to overwrite and returns a conflict (skipped) result
 *  5. Running migrate twice in a row (without --force) is a no-op on the second run
 */

import { describe, it, expect } from "bun:test";
import { migrateRules } from "./migration-operations";
import type { MigrateFsDeps } from "./types";

// ─── In-memory fake fs ────────────────────────────────────────────────────────

/**
 * Builds a MigrateFsDeps backed by a plain object store.
 * Files are keyed by absolute path; their value is the raw string content.
 * Callers can inspect `store` after a run to assert writes.
 */
function makeFakeFs(initialFiles: Record<string, string> = {}): {
  store: Record<string, string>;
  fs: MigrateFsDeps;
} {
  const store: Record<string, string> = { ...initialFiles };

  const fsDeps: MigrateFsDeps = {
    async readdir(path: string): Promise<string[]> {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const entries = Object.keys(store)
        .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
        .map((k) => k.slice(prefix.length));
      if (entries.length === 0 && !Object.keys(store).some((k) => k.startsWith(prefix))) {
        // Simulate ENOENT for directories that have no entries and no parent path match
        throw Object.assign(new Error(`ENOENT: no such file or directory: '${path}'`), {
          code: "ENOENT",
        });
      }
      return entries;
    },

    async mkdir(_path: string, _opts?: { recursive?: boolean }): Promise<undefined> {
      return undefined;
    },

    async access(path: string): Promise<void> {
      if (!(path in store)) {
        throw Object.assign(new Error(`ENOENT: no such file or directory: '${path}'`), {
          code: "ENOENT",
        });
      }
    },

    async readFile(path: string): Promise<Buffer> {
      const content = store[path];
      if (content === undefined) {
        throw Object.assign(new Error(`ENOENT: no such file or directory: '${path}'`), {
          code: "ENOENT",
        });
      }
      return Buffer.from(content);
    },

    async writeFile(path: string, data: Buffer | string): Promise<void> {
      store[path] = typeof data === "string" ? data : data.toString();
    },
  };

  return { store, fs: fsDeps };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const WS = "/mock/workspace";
const SRC = `${WS}/.cursor/rules`;
const DEST = `${WS}/.minsky/rules`;

const CONTENT_A = "---\nname: Rule A\n---\nContent A";
const CONTENT_B = "---\nname: Rule B\n---\nContent B";
const CONTENT_C = "---\nname: Rule C\n---\nContent C";

/** Three sample .mdc files in the source directory. */
const INITIAL_SOURCE: Record<string, string> = {
  [`${SRC}/rule-a.mdc`]: CONTENT_A,
  [`${SRC}/rule-b.mdc`]: CONTENT_B,
  [`${SRC}/rule-c.mdc`]: CONTENT_C,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("migrateRules()", () => {
  // ── Scenario 1: dry-run ───────────────────────────────────────────────────
  describe("scenario 1 — dry-run", () => {
    it("returns the list of files that would be migrated without writing anything", async () => {
      const { store, fs } = makeFakeFs(INITIAL_SOURCE);
      const initialKeys = new Set(Object.keys(store));

      const result = await migrateRules({
        workspacePath: WS,
        dryRun: true,
        force: false,
        fsDeps: fs,
      });

      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(result.migrated).toEqual(
        expect.arrayContaining(["rule-a.mdc", "rule-b.mdc", "rule-c.mdc"])
      );
      expect(result.migrated).toHaveLength(3);
      expect(result.skipped).toEqual([]);

      // No files were written — store is identical to before
      expect(new Set(Object.keys(store))).toEqual(initialKeys);
    });

    it("reports source and dest directories", async () => {
      const { fs } = makeFakeFs(INITIAL_SOURCE);
      const result = await migrateRules({
        workspacePath: WS,
        dryRun: true,
        force: false,
        fsDeps: fs,
      });

      expect(result.sourceDir).toBe(SRC);
      expect(result.destDir).toBe(DEST);
    });
  });

  // ── Scenario 2: real run copies and preserves content ────────────────────
  describe("scenario 2 — real run", () => {
    it("copies every .mdc file from source to dest preserving content", async () => {
      const { store, fs } = makeFakeFs(INITIAL_SOURCE);

      const result = await migrateRules({
        workspacePath: WS,
        dryRun: false,
        force: false,
        fsDeps: fs,
      });

      expect(result.success).toBe(true);
      expect(result.migrated).toHaveLength(3);
      expect(result.skipped).toEqual([]);

      // All three destination files exist with the original content
      for (const [srcPath, srcContent] of Object.entries(INITIAL_SOURCE)) {
        const parts = srcPath.split("/");
        const filename = parts[parts.length - 1];
        const destPath = `${DEST}/${filename}`;
        expect(store[destPath]).toBe(srcContent);
      }
    });

    it("only copies .mdc files — ignores other extensions", async () => {
      const { store, fs } = makeFakeFs({
        ...INITIAL_SOURCE,
        [`${SRC}/README.md`]: "# readme",
        [`${SRC}/notes.txt`]: "some notes",
      });

      await migrateRules({ workspacePath: WS, dryRun: false, force: false, fsDeps: fs });

      expect(`${DEST}/README.md` in store).toBe(false);
      expect(`${DEST}/notes.txt` in store).toBe(false);
    });
  });

  // ── Scenario 3: --force overwrites existing files ────────────────────────
  describe("scenario 3 — --force overwrites existing destination files", () => {
    it("overwrites destination files that already exist", async () => {
      const oldContent = "---\nname: Old\n---\nOld content";
      const { store, fs } = makeFakeFs({
        ...INITIAL_SOURCE,
        [`${DEST}/rule-a.mdc`]: oldContent, // pre-existing destination
      });

      const result = await migrateRules({
        workspacePath: WS,
        dryRun: false,
        force: true,
        fsDeps: fs,
      });

      expect(result.success).toBe(true);
      // rule-a.mdc was migrated (not skipped) even though it pre-existed
      expect(result.migrated).toContain("rule-a.mdc");
      expect(result.skipped).not.toContain("rule-a.mdc");

      // Content is now the source content, not the old content
      expect(store[`${DEST}/rule-a.mdc`]).toBe(CONTENT_A);
    });
  });

  // ── Scenario 4: without --force, refuses to overwrite ────────────────────
  describe("scenario 4 — without --force, skips existing destination files", () => {
    it("skips files that already exist in the destination and reports them", async () => {
      const existingContent = "---\nname: Existing\n---\nExisting content";
      const { store, fs } = makeFakeFs({
        ...INITIAL_SOURCE,
        [`${DEST}/rule-a.mdc`]: existingContent, // pre-existing
      });

      const result = await migrateRules({
        workspacePath: WS,
        dryRun: false,
        force: false,
        fsDeps: fs,
      });

      expect(result.success).toBe(true);
      expect(result.skipped).toContain("rule-a.mdc");
      expect(result.migrated).not.toContain("rule-a.mdc");
      // The existing content is preserved
      expect(store[`${DEST}/rule-a.mdc`]).toBe(existingContent);
    });

    it("still migrates files that do not yet exist in the destination", async () => {
      const { store, fs } = makeFakeFs({
        ...INITIAL_SOURCE,
        [`${DEST}/rule-a.mdc`]: "existing", // only rule-a pre-exists
      });

      const result = await migrateRules({
        workspacePath: WS,
        dryRun: false,
        force: false,
        fsDeps: fs,
      });

      // rule-b and rule-c should be migrated
      expect(result.migrated).toContain("rule-b.mdc");
      expect(result.migrated).toContain("rule-c.mdc");
      expect(store[`${DEST}/rule-b.mdc`]).toBe(CONTENT_B);
      expect(store[`${DEST}/rule-c.mdc`]).toBe(CONTENT_C);
    });
  });

  // ── Scenario 5: idempotent — second run without --force is a no-op ───────
  describe("scenario 5 — idempotent: second run without --force is a no-op", () => {
    it("skips all files on the second run when --force is not set", async () => {
      const { store, fs } = makeFakeFs(INITIAL_SOURCE);

      // First run — migrates everything
      const first = await migrateRules({
        workspacePath: WS,
        dryRun: false,
        force: false,
        fsDeps: fs,
      });
      expect(first.migrated).toHaveLength(3);
      expect(first.skipped).toHaveLength(0);

      // Second run — all files already exist, should skip all
      const second = await migrateRules({
        workspacePath: WS,
        dryRun: false,
        force: false,
        fsDeps: fs,
      });

      expect(second.success).toBe(true);
      expect(second.migrated).toHaveLength(0);
      expect(second.skipped).toHaveLength(3);
      expect(second.skipped).toEqual(
        expect.arrayContaining(["rule-a.mdc", "rule-b.mdc", "rule-c.mdc"])
      );

      // Content is unchanged — still equals what was written in the first run
      expect(store[`${DEST}/rule-a.mdc`]).toBe(CONTENT_A);
      expect(store[`${DEST}/rule-b.mdc`]).toBe(CONTENT_B);
      expect(store[`${DEST}/rule-c.mdc`]).toBe(CONTENT_C);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────────
  describe("error cases", () => {
    it("returns an error when source directory does not exist", async () => {
      const { fs } = makeFakeFs({}); // empty store — no source dir

      const result = await migrateRules({
        workspacePath: WS,
        dryRun: false,
        force: false,
        fsDeps: fs,
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Source directory does not exist/);
    });

    it("returns an error when source directory has no .mdc files", async () => {
      const { fs } = makeFakeFs({
        [`${SRC}/README.md`]: "# readme", // only non-.mdc file
      });

      const result = await migrateRules({
        workspacePath: WS,
        dryRun: false,
        force: false,
        fsDeps: fs,
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/No .mdc files found/);
    });
  });
});
