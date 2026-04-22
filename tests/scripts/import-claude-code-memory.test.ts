/**
 * Unit tests for the Claude Code memory importer (mt#1008).
 *
 * Tests cover the core decision logic: which files get imported, which get
 * skipped, and under what conditions.  Uses a fake MemoryServiceSurface and
 * a fake FsAdapter (in-memory file map) — no real filesystem operations.
 *
 * What is NOT tested here:
 *  - Actual CLI argument parsing (integration concern)
 *  - Real DB or file-system side effects
 *  - Content of written report files
 */

import { describe, test, expect } from "bun:test";
import * as crypto from "crypto";
import * as path from "path";
import { runImport, type FsAdapter } from "../../scripts/import-claude-code-memory";
import type { MemoryServiceSurface } from "../../src/domain/memory/memory-service";
import type {
  MemoryRecord,
  MemoryCreateInput,
  MemorySearchResult,
  MemorySearchResponse,
  MemoryListFilter,
  MemorySearchOptions,
} from "../../src/domain/memory/types";

// ─── Fake MemoryServiceSurface ────────────────────────────────────────────────

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem-test-1",
    type: "user",
    name: "Test Memory",
    description: "A test memory",
    content: "some content",
    scope: "user",
    projectId: null,
    tags: [],
    sourceAgentId: null,
    sourceSessionId: null,
    confidence: null,
    supersededBy: null,
    metadata: null,
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
    lastAccessedAt: null,
    accessCount: 0,
    ...overrides,
  };
}

function makeFakeService(existing: MemoryRecord[] = []): MemoryServiceSurface & {
  created: MemoryCreateInput[];
} {
  const created: MemoryCreateInput[] = [];
  let nextId = 1;

  return {
    created,

    list: async (_filter?: MemoryListFilter) => existing,

    create: async (input: MemoryCreateInput) => {
      created.push(input);
      return makeRecord({ id: `mem-${nextId++}`, ...input });
    },

    get: async (_id: string) => null,

    search: async (_query: string, _opts?: MemorySearchOptions): Promise<MemorySearchResponse> => ({
      results: [],
      backend: "none",
      degraded: true,
    }),

    update: async (_id: string, _input) => null,

    delete: async (_id: string) => {},

    similar: async (_id: string, _opts?): Promise<MemorySearchResult[]> => [],

    supersede: async (_oldId: string, newInput: MemoryCreateInput, _reason?: string) => ({
      old: makeRecord({ id: _oldId }),
      replacement: makeRecord({ ...newInput }),
    }),
  } satisfies MemoryServiceSurface & { created: MemoryCreateInput[] };
}

// ─── Fake FsAdapter ───────────────────────────────────────────────────────────

/**
 * Build a fake FsAdapter from an in-memory map of filename → content.
 * The sourceDir parameter is ignored — filenames are resolved directly from the map.
 */
function makeFakeFs(files: Record<string, string>): FsAdapter {
  return {
    listFiles: (_sourceDir: string): string[] =>
      Object.keys(files)
        .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
        .sort(),

    readFile: (filepath: string): string => {
      const filename = path.basename(filepath);
      const content = files[filename];
      if (content === undefined) {
        throw new Error(`ENOENT: no such file: ${filepath}`);
      }
      return content;
    },
  };
}

const FAKE_SOURCE_DIR = "/mock/memory";

// ─── Fixture filenames ────────────────────────────────────────────────────────

const F_USER_PROFILE = "user_profile.md";
const F_FEEDBACK_STALE = "feedback_stale.md";
const F_FEEDBACK_CODE = "feedback_code.md";
const F_FEEDBACK_TESTING = "feedback_testing.md";
const F_FEEDBACK_DONE = "feedback_done.md";
const F_PROJECT_ARCH = "project_architecture.md";
const F_REFERENCE_NOTION = "reference_notion.md";
const F_USER_BROKEN = "user_broken.md";
const F_USER_MYSTERY = "user_mystery.md";

// ─── Fixture contents ─────────────────────────────────────────────────────────

const CLEAN_FRONTMATTER = `---
name: User Profile
description: edobry is a TypeScript engineer
type: user
---

edobry prefers strict TypeScript and values clean architecture.
`;

const RESOLVED_CONTENT = `---
name: Stale Memory
description: A resolved issue
type: feedback
---

This item is now RESOLVED and should be skipped.
`;

const DERIVABLE_CONTENT = `---
name: Code fact
description: Derivable from code
type: feedback
---

The function foo in src/bar.ts handles request validation.
`;

const MISSING_FRONTMATTER = `No YAML frontmatter here — just raw text that should be skipped.`;

const REFERENCE_CONTENT = `---
name: Architecture ref
description: Architecture decision
type: reference
---

Minsky uses clean architecture with domain, adapters, and infrastructure layers.
`;

// ─── Helper ───────────────────────────────────────────────────────────────────

type RunOptions = {
  files: Record<string, string>;
  existing?: MemoryRecord[];
  dryRun?: boolean;
  forceExisting?: boolean;
};

async function runWith(opts: RunOptions) {
  const service = makeFakeService(opts.existing ?? []);
  const fsAdapter = makeFakeFs(opts.files);
  const report = await runImport(service, {
    dryRun: opts.dryRun ?? false,
    forceExisting: opts.forceExisting ?? false,
    sourceDir: FAKE_SOURCE_DIR,
    fsAdapter,
  });
  return { report, service };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("runImport", () => {
  // ── Basic import ─────────────────────────────────────────────────────────────

  describe("basic import", () => {
    test("imports a clean file and records it in the report", async () => {
      const { report, service } = await runWith({
        files: { [F_USER_PROFILE]: CLEAN_FRONTMATTER },
      });

      expect(report.imported).toHaveLength(1);
      expect(report.imported[0]?.file).toBe(F_USER_PROFILE);
      expect(report.imported[0]?.name).toBe("User Profile");
      expect(report.skipped).toHaveLength(0);
      expect(report.errors).toHaveLength(0);
      expect(service.created).toHaveLength(1);
    });

    test("MEMORY.md is always skipped by the FsAdapter", async () => {
      const { report } = await runWith({
        files: {
          "MEMORY.md": CLEAN_FRONTMATTER,
          [F_USER_PROFILE]: CLEAN_FRONTMATTER,
        },
      });

      // Only user_profile.md should be processed
      expect(report.imported).toHaveLength(1);
      expect(report.imported[0]?.file).toBe(F_USER_PROFILE);
    });

    test("tags include imported-from:claude-code and content-hash", async () => {
      const { service } = await runWith({
        files: { [F_USER_PROFILE]: CLEAN_FRONTMATTER },
      });

      const created = service.created[0];
      expect(created?.tags).toContain("imported-from:claude-code");
      const hashTag = created?.tags?.find((t) => t.startsWith("content-hash:"));
      expect(hashTag).toBeDefined();
      expect(hashTag?.length).toBeGreaterThan("content-hash:".length);
    });

    test("sourceAgentId and sourceSessionId are null for imported memories", async () => {
      const { service } = await runWith({
        files: { [F_USER_PROFILE]: CLEAN_FRONTMATTER },
      });

      expect(service.created[0]?.sourceAgentId).toBeNull();
      expect(service.created[0]?.sourceSessionId).toBeNull();
    });
  });

  // ── Scope heuristics ──────────────────────────────────────────────────────────

  describe("scope heuristic", () => {
    test("user_*.md gets scope=user", async () => {
      const { service } = await runWith({
        files: { [F_USER_PROFILE]: CLEAN_FRONTMATTER },
      });
      expect(service.created[0]?.scope).toBe("user");
    });

    test("feedback_*.md gets scope=user", async () => {
      const content = `---\nname: Testing feedback\ndescription: Testing preferences\ntype: feedback\n---\n\nedobry prefers test-driven development.\n`;
      const { service } = await runWith({ files: { [F_FEEDBACK_TESTING]: content } });
      expect(service.created[0]?.scope).toBe("user");
    });

    test("project_*.md gets scope=project", async () => {
      const content = `---\nname: Architecture\ndescription: Project architecture\ntype: project\n---\n\nMinsky follows clean architecture principles.\n`;
      const { service } = await runWith({ files: { [F_PROJECT_ARCH]: content } });
      expect(service.created[0]?.scope).toBe("project");
    });

    test("reference_*.md gets scope=project", async () => {
      const { service } = await runWith({
        files: { [F_REFERENCE_NOTION]: REFERENCE_CONTENT },
      });
      expect(service.created[0]?.scope).toBe("project");
    });
  });

  // ── Skip: stale marker ────────────────────────────────────────────────────────

  describe("stale marker skip (mt#960 rubric)", () => {
    test("skips file containing RESOLVED", async () => {
      const { report, service } = await runWith({
        files: { [F_FEEDBACK_STALE]: RESOLVED_CONTENT },
      });

      expect(report.imported).toHaveLength(0);
      expect(report.skipped).toHaveLength(1);
      expect(report.skipped[0]?.file).toBe(F_FEEDBACK_STALE);
      expect(report.skipped[0]?.reason).toMatch(/RESOLVED/);
      expect(service.created).toHaveLength(0);
    });

    test("skips file containing COMPLETE", async () => {
      const content = `---
name: Complete item
description: Done
type: feedback
---

This work is COMPLETE and no longer relevant.
`;
      const { report } = await runWith({ files: { [F_FEEDBACK_DONE]: content } });
      expect(report.skipped[0]?.reason).toMatch(/COMPLETE/);
    });
  });

  // ── Skip: derivable content ───────────────────────────────────────────────────

  describe("derivable content skip (mt#960 rubric)", () => {
    test("skips content flagged by checkDerivation", async () => {
      const { report, service } = await runWith({
        files: { [F_FEEDBACK_CODE]: DERIVABLE_CONTENT },
      });

      expect(report.imported).toHaveLength(0);
      expect(report.skipped).toHaveLength(1);
      expect(report.skipped[0]?.reason).toMatch(/derivable/);
      expect(service.created).toHaveLength(0);
    });
  });

  // ── Skip: invalid frontmatter ─────────────────────────────────────────────────

  describe("frontmatter validation skip", () => {
    test("skips file with missing frontmatter fields", async () => {
      const { report } = await runWith({
        files: { [F_USER_BROKEN]: MISSING_FRONTMATTER },
      });
      expect(report.skipped[0]?.reason).toBe("invalid frontmatter");
    });

    test("skips file with unknown type", async () => {
      const content = `---
name: Mystery
description: Unknown type test
type: magical
---

Some content here.
`;
      const { report } = await runWith({ files: { [F_USER_MYSTERY]: content } });
      expect(report.skipped[0]?.reason).toMatch(/unknown type/);
    });
  });

  // ── Idempotency (content hash dedup) ─────────────────────────────────────────

  describe("idempotency via content hash", () => {
    test("skips file whose content hash is already in existing records", async () => {
      const body = "edobry prefers strict TypeScript and values clean architecture.";
      const hash = crypto.createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16);

      const existingRecord = makeRecord({
        id: "pre-existing",
        tags: [`content-hash:${hash}`, "imported-from:claude-code"],
      });

      const { report, service } = await runWith({
        files: { [F_USER_PROFILE]: CLEAN_FRONTMATTER },
        existing: [existingRecord],
      });

      expect(report.imported).toHaveLength(0);
      expect(report.skipped).toHaveLength(1);
      expect(report.skipped[0]?.reason).toBe("duplicate content hash");
      expect(service.created).toHaveLength(0);
    });

    test("--force-existing re-imports even with matching hash", async () => {
      const body = "edobry prefers strict TypeScript and values clean architecture.";
      const hash = crypto.createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16);

      const existingRecord = makeRecord({
        id: "pre-existing",
        tags: [`content-hash:${hash}`],
      });

      const { report, service } = await runWith({
        files: { [F_USER_PROFILE]: CLEAN_FRONTMATTER },
        existing: [existingRecord],
        forceExisting: true,
      });

      expect(report.imported).toHaveLength(1);
      expect(service.created).toHaveLength(1);
    });
  });

  // ── Dry run ───────────────────────────────────────────────────────────────────

  describe("dry run", () => {
    test("dry-run reports would-be imports without calling create", async () => {
      const { report, service } = await runWith({
        files: { [F_USER_PROFILE]: CLEAN_FRONTMATTER },
        dryRun: true,
      });

      expect(report.dryRun).toBe(true);
      expect(report.imported).toHaveLength(1);
      expect(report.imported[0]?.id).toBe("(dry-run)");
      expect(service.created).toHaveLength(0);
    });

    test("dry-run still applies skip heuristics", async () => {
      const { report, service } = await runWith({
        files: {
          [F_USER_PROFILE]: CLEAN_FRONTMATTER,
          [F_FEEDBACK_STALE]: RESOLVED_CONTENT,
          [F_FEEDBACK_CODE]: DERIVABLE_CONTENT,
        },
        dryRun: true,
      });

      expect(report.imported).toHaveLength(1);
      expect(report.skipped).toHaveLength(2);
      expect(service.created).toHaveLength(0);
    });
  });

  // ── Mixed scenario ────────────────────────────────────────────────────────────

  describe("mixed scenario", () => {
    test("correctly counts imported, skipped, and errors across multiple files", async () => {
      const { report, service } = await runWith({
        files: {
          [F_USER_PROFILE]: CLEAN_FRONTMATTER,
          [F_FEEDBACK_STALE]: RESOLVED_CONTENT,
          [F_FEEDBACK_CODE]: DERIVABLE_CONTENT,
          [F_USER_BROKEN]: MISSING_FRONTMATTER,
          [F_REFERENCE_NOTION]: REFERENCE_CONTENT,
        },
      });

      // user_profile.md and reference_notion.md should import (2)
      expect(report.imported).toHaveLength(2);
      // feedback_stale.md (RESOLVED), feedback_code.md (derivable), user_broken.md (frontmatter) skip (3)
      expect(report.skipped).toHaveLength(3);
      expect(report.errors).toHaveLength(0);
      expect(service.created).toHaveLength(2);
    });
  });

  // ── Report shape ──────────────────────────────────────────────────────────────

  describe("report shape", () => {
    test("report has expected top-level fields", async () => {
      const { report } = await runWith({
        files: { [F_USER_PROFILE]: CLEAN_FRONTMATTER },
      });

      expect(typeof report.timestamp).toBe("string");
      expect(report.source).toBe(FAKE_SOURCE_DIR);
      expect(report.dryRun).toBe(false);
      expect(Array.isArray(report.imported)).toBe(true);
      expect(Array.isArray(report.skipped)).toBe(true);
      expect(Array.isArray(report.errors)).toBe(true);
    });
  });
});
