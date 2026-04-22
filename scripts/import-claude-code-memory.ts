#!/usr/bin/env bun
/**
 * One-shot importer: Claude Code harness-private memory → Minsky DB.
 *
 * Reads *.md files from the Claude Code project memory directory, applies
 * the mt#960 rubric skip heuristics, and imports surviving entries into the
 * Minsky DB via MemoryService.create.  Idempotent: re-runs skip files whose
 * content hash already exists in the DB.
 *
 * Usage:
 *   bun run scripts/import-claude-code-memory.ts [flags]
 *
 * Flags:
 *   --dry-run           Parse + report without writing to DB.
 *   --source <path>     Override the default source directory.
 *   --force-existing    Re-import even if content hash matches an existing memory.
 *
 * Exit codes:
 *   0 — success (some skips are fine)
 *   1 — one or more per-file errors during processing
 *   2 — fatal config error (source directory missing)
 *
 * @see mt#1008
 */

import "reflect-metadata";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import matter from "gray-matter";
import { readTextFileSync } from "../src/utils/fs";
import { checkDerivation } from "../src/domain/memory/validation";
import type { MemoryServiceSurface, MemoryServiceDb } from "../src/domain/memory/memory-service";
import type {
  MemoryType,
  MemoryScope,
  MemoryCreateInput,
  MemoryRecord,
} from "../src/domain/memory/types";
import { MEMORY_TYPES } from "../src/domain/memory/types";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ImportedEntry {
  id: string;
  file: string;
  name: string;
}

interface SkippedEntry {
  file: string;
  reason: string;
}

interface ErrorEntry {
  file: string;
  error: string;
}

interface ImportReport {
  timestamp: string;
  source: string;
  dryRun: boolean;
  imported: ImportedEntry[];
  skipped: SkippedEntry[];
  errors: ErrorEntry[];
}

interface ParsedMemoryFile {
  name: string;
  description: string;
  type: MemoryType;
  originSessionId?: string;
  body: string;
}

// ─── CLI flag parsing ─────────────────────────────────────────────────────────

interface CliFlags {
  dryRun: boolean;
  sourceDir: string | null;
  forceExisting: boolean;
}

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = {
    dryRun: false,
    sourceDir: null,
    forceExisting: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      flags.dryRun = true;
    } else if (arg === "--force-existing") {
      flags.forceExisting = true;
    } else if (arg === "--source") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        console.error("Error: --source requires a path argument.");
        process.exit(2);
      }
      flags.sourceDir = next;
      i++;
    }
  }

  return flags;
}

// ─── Default source path resolution ──────────────────────────────────────────

/**
 * Derive the default Claude Code memory directory for the current project.
 * Claude Code uses a hash of the absolute path (slashes → dashes, leading dash).
 * e.g., /Users/edobry/Projects/minsky → -Users-edobry-Projects-minsky
 */
function defaultSourceDir(): string {
  const cwd = process.cwd();
  const hash = cwd.replace(/\//g, "-");
  return path.join(process.env["HOME"] ?? "~", ".claude", "projects", hash, "memory");
}

// ─── Scope heuristic ──────────────────────────────────────────────────────────

/**
 * Derive the Minsky MemoryScope from the filename prefix.
 *   user_*.md      → "user"
 *   feedback_*.md  → "user"  (applies across projects for the same user)
 *   project_*.md   → "project"
 *   reference_*.md → "project"
 */
function scopeForFile(filename: string): MemoryScope {
  const base = path.basename(filename);
  if (base.startsWith("user_") || base.startsWith("feedback_")) {
    return "user";
  }
  return "project";
}

// ─── Content hash ─────────────────────────────────────────────────────────────

/**
 * SHA-256 of the body text, first 16 hex chars.
 * Stored as a tag: content-hash:<hex>
 */
function contentHash(body: string): string {
  return crypto.createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16);
}

// ─── Frontmatter parsing ──────────────────────────────────────────────────────

interface ParseResult {
  ok: true;
  data: ParsedMemoryFile;
}

interface ParseError {
  ok: false;
  reason: string;
}

function parseMemoryFile(fileContent: string): ParseResult | ParseError {
  const parsed = matter(fileContent);
  const fm = parsed.data as Record<string, unknown>;
  const body = parsed.content.trim();

  const name = typeof fm["name"] === "string" ? fm["name"].trim() : undefined;
  const description = typeof fm["description"] === "string" ? fm["description"].trim() : undefined;
  const rawType = typeof fm["type"] === "string" ? fm["type"].trim() : undefined;

  if (!name || !description || !rawType) {
    return { ok: false, reason: "invalid frontmatter" };
  }

  // Validate type is one of the 4 Minsky types
  const knownTypes = Object.values(MEMORY_TYPES);
  if (!knownTypes.includes(rawType as MemoryType)) {
    return { ok: false, reason: `unknown type: ${rawType}` };
  }

  const type = rawType as MemoryType;
  const originSessionId =
    typeof fm["originSessionId"] === "string" ? fm["originSessionId"] : undefined;

  return { ok: true, data: { name, description, type, originSessionId, body } };
}

// ─── Skip heuristics (mt#960 rubric) ─────────────────────────────────────────

function checkStale(body: string): string | null {
  if (body.includes("RESOLVED") || body.includes("COMPLETE")) {
    return "stale (mt#960 rubric: RESOLVED/COMPLETE marker)";
  }
  return null;
}

function checkDerivable(body: string): string | null {
  const issue = checkDerivation(body);
  if (issue) {
    return `derivable (mt#960 rubric: ${issue.source})`;
  }
  return null;
}

// ─── Existing hash set ────────────────────────────────────────────────────────

/**
 * Build a Set of content hashes already present in the DB.
 * Hashes are stored as tags like "content-hash:abc123deadbeef01".
 */
function buildExistingHashSet(records: MemoryRecord[]): Set<string> {
  const hashes = new Set<string>();
  for (const record of records) {
    for (const tag of record.tags) {
      if (tag.startsWith("content-hash:")) {
        hashes.add(tag.slice("content-hash:".length));
      }
    }
  }
  return hashes;
}

// ─── Core import logic (testable) ─────────────────────────────────────────────

/**
 * Injectable filesystem adapter for unit tests.
 * Allows tests to pass in-memory file data without touching the real filesystem.
 */
export interface FsAdapter {
  /** Return sorted list of .md filenames (basenames only) in the source dir, excluding MEMORY.md */
  listFiles(sourceDir: string): string[];
  /** Return the content of the file at the given path */
  readFile(filepath: string): string;
}

export interface ImportOptions {
  dryRun: boolean;
  forceExisting: boolean;
  sourceDir: string;
  /** Override filesystem operations (for unit tests). Defaults to real fs. */
  fsAdapter?: FsAdapter;
}

export async function runImport(
  service: MemoryServiceSurface,
  options: ImportOptions
): Promise<ImportReport> {
  const { dryRun, forceExisting, sourceDir } = options;

  const report: ImportReport = {
    timestamp: new Date().toISOString(),
    source: sourceDir,
    dryRun,
    imported: [],
    skipped: [],
    errors: [],
  };

  const adapter: FsAdapter = options.fsAdapter ?? {
    listFiles: (dir) =>
      fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
        .sort(),
    readFile: (filepath) => readTextFileSync(filepath),
  };

  // Discover .md files (non-recursive), skipping MEMORY.md
  let files: string[];
  try {
    files = adapter.listFiles(sourceDir);
  } catch (err) {
    // Should not reach here — caller checks dir existence
    report.errors.push({ file: "(dir)", error: `Cannot read directory: ${String(err)}` });
    return report;
  }

  // Build existing hash set for idempotency
  let existingHashes: Set<string>;
  try {
    const existing = await service.list();
    existingHashes = buildExistingHashSet(existing);
  } catch (err) {
    report.errors.push({ file: "(list)", error: `Cannot list existing memories: ${String(err)}` });
    return report;
  }

  for (const filename of files) {
    const filepath = path.join(sourceDir, filename);

    let fileContent: string;
    try {
      fileContent = adapter.readFile(filepath);
    } catch (err) {
      report.errors.push({ file: filename, error: `Cannot read file: ${String(err)}` });
      continue;
    }

    // Parse frontmatter
    const parseResult = parseMemoryFile(fileContent);
    if (!parseResult.ok) {
      report.skipped.push({ file: filename, reason: parseResult.reason });
      continue;
    }

    const { name, description, type, body } = parseResult.data;

    // Skip heuristic: stale markers
    const staleReason = checkStale(body);
    if (staleReason) {
      report.skipped.push({ file: filename, reason: staleReason });
      continue;
    }

    // Skip heuristic: derivable content
    const derivableReason = checkDerivable(body);
    if (derivableReason) {
      report.skipped.push({ file: filename, reason: derivableReason });
      continue;
    }

    // Idempotency: skip if content hash already exists (unless --force-existing)
    const hash = contentHash(body);
    if (existingHashes.has(hash) && !forceExisting) {
      report.skipped.push({ file: filename, reason: "duplicate content hash" });
      continue;
    }

    // Dry run: record as would-be import without writing
    if (dryRun) {
      report.imported.push({ id: "(dry-run)", file: filename, name });
      continue;
    }

    // Create the memory
    const scope = scopeForFile(filename);
    const input: MemoryCreateInput = {
      type,
      name,
      description,
      content: body,
      scope,
      projectId: null,
      tags: [`imported-from:claude-code`, `content-hash:${hash}`],
      sourceAgentId: null,
      sourceSessionId: null,
      confidence: null,
    };

    try {
      const record = await service.create(input);
      report.imported.push({ id: record.id, file: filename, name });
      // Track newly-imported hashes so re-encounters in the same run are deduped
      existingHashes.add(hash);
    } catch (err) {
      report.errors.push({ file: filename, error: String(err) });
    }
  }

  return report;
}

// ─── Report persistence ───────────────────────────────────────────────────────

function saveReport(report: ImportReport): string {
  const reportsDir = path.join(process.cwd(), "scripts", ".import-reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  const isoStamp = report.timestamp.replace(/[:.]/g, "-");
  const reportPath = path.join(reportsDir, `${isoStamp}.json`);

  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return reportPath;
}

// ─── Real MemoryService factory ───────────────────────────────────────────────

async function buildMemoryService(): Promise<MemoryServiceSurface> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "../src/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");
  const { PersistenceProvider } = await import("../src/domain/persistence/types");
  const { createEmbeddingServiceFromConfig } = await import(
    "../src/domain/ai/embedding-service-factory"
  );
  const { createVectorStorageFromConfig } = await import(
    "../src/domain/storage/vector/vector-storage-factory"
  );
  const { MemoryService } = await import("../src/domain/memory");

  await initializeConfiguration(new CustomConfigFactory(), {
    workingDirectory: process.cwd(),
  });

  const container = await createCliContainer();
  await container.initialize();

  const persistence = container.has("persistence") ? container.get("persistence") : undefined;

  if (!persistence) {
    throw new Error(
      "Memory import requires a persistence provider. " +
        "Set up Minsky with a Postgres backend before running."
    );
  }

  if (!(persistence instanceof PersistenceProvider)) {
    throw new Error(
      "Memory import requires a PersistenceProvider instance; got incompatible DI binding."
    );
  }

  if (!persistence.capabilities.sql || typeof persistence.getDatabaseConnection !== "function") {
    throw new Error(
      "Memory import requires a SQL-capable persistence provider (Postgres). " +
        `Got provider with capabilities: ${JSON.stringify(persistence.capabilities)}`
    );
  }

  const connection = await persistence.getDatabaseConnection();
  if (!connection) {
    throw new Error(
      "Memory import requires an initialized Postgres database connection; got null."
    );
  }

  const db = connection as MemoryServiceDb;

  const embeddingService = await createEmbeddingServiceFromConfig();
  const vectorStorage = await createVectorStorageFromConfig(1536, persistence);

  return new MemoryService({ db, vectorStorage, embeddingService });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags = parseFlags(process.argv);

  const sourceDir = flags.sourceDir ?? defaultSourceDir();

  // Fatal check: source dir must exist
  if (!fs.existsSync(sourceDir)) {
    console.error(`Error: Source directory does not exist: ${sourceDir}`);
    console.error(
      "Use --source <path> to specify an alternative, or ensure the Claude Code memory " +
        "directory is initialized for this project."
    );
    process.exit(2);
  }

  console.log(`Source directory: ${sourceDir}`);
  if (flags.dryRun) console.log("Mode: dry-run (no writes to DB)");
  if (flags.forceExisting) console.log("Mode: force-existing (re-importing duplicate hashes)");

  const service = await buildMemoryService();

  const report = await runImport(service, {
    dryRun: flags.dryRun,
    forceExisting: flags.forceExisting,
    sourceDir,
  });

  const reportPath = saveReport(report);

  const importedCount = report.imported.length;
  const skippedCount = report.skipped.length;
  const errorCount = report.errors.length;

  console.log(
    `Imported ${importedCount}, Skipped ${skippedCount}, Errors ${errorCount}. Report: ${reportPath}`
  );

  if (report.skipped.length > 0) {
    console.log("\nSkipped:");
    for (const s of report.skipped) {
      console.log(`  ${s.file}: ${s.reason}`);
    }
  }

  if (report.errors.length > 0) {
    console.log("\nErrors:");
    for (const e of report.errors) {
      console.error(`  ${e.file}: ${e.error}`);
    }
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
