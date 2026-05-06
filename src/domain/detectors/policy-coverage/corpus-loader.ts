/**
 * Policy corpus loader — Surface 1 of the System 3* detector.
 *
 * Reads the 5 policy sources per mt#1035 §Surface 1 and returns a queryable
 * `PolicyCorpus` shape. All I/O is wrapped in try/catch; failures yield
 * safe defaults ("policy unavailable") without blocking the detector.
 *
 * Sources (in order of authority):
 *   1. Task spec — via `tasks_spec_get` if a task ID is in tool-call context
 *   2. CLAUDE.md — project-level (.claude/CLAUDE.md or CLAUDE.md) + user-level
 *   3. Project rules — .claude/rules/* + .minsky/rules/* (including decision-defaults.mdc)
 *   4. Long-lived memories — ~/.claude/projects/…/memory/{feedback,project}_*.md
 *   5. Future .minsky/policy/* — gracefully handled if dir is absent
 *
 * In-memory load on detector startup; persistent indexing is v0.2.
 *
 * Reference: docs/research/mt1035-system3-detector.md §Surface 1 §Policy corpus
 */

import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { log } from "../../../utils/logger";

// ---------------------------------------------------------------------------
// Sync exec helper for task-spec loading
// ---------------------------------------------------------------------------

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Synchronous exec helper with PATH augmentation.
 *
 * Uses `Bun.spawnSync` per project rule `bun_over_node.mdc` — the project's
 * runtime is Bun (including `bun:test` which is the test runner), so Bun
 * globals are available everywhere domain code runs. ESLint
 * `no-restricted-imports` actively bans `node:child_process` for new code.
 * Mirrors the `execWithPath` helper in `.claude/hooks/types.ts`.
 */
function execWithPath(
  cmd: string[],
  options?: { timeout?: number; env?: NodeJS.ProcessEnv }
): ExecResult {
  const pathPrefix = `/opt/homebrew/bin:/usr/local/bin:${process.env["PATH"] ?? ""}`;
  const env = options?.env ?? { ...process.env, PATH: pathPrefix };
  const result = Bun.spawnSync(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    timeout: options?.timeout ?? 5000,
    env,
  });
  const timedOut = result.exitCode === null && result.signalCode === "SIGTERM";
  return {
    exitCode: timedOut ? 1 : (result.exitCode ?? 1),
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

// ---------------------------------------------------------------------------
// PolicyEntry — a single loaded policy document
// ---------------------------------------------------------------------------

/** A single loaded policy document. */
export interface PolicyEntry {
  /** Short identifier for this source (e.g. "decision-defaults.mdc"). */
  source: string;
  /** Full file path or logical identifier (e.g. "task-spec:mt#123"). */
  ref: string;
  /** The raw text content of this policy document. */
  content: string;
  /** Which of the 5 source categories this entry belongs to. */
  category: "task-spec" | "claude-md" | "project-rule" | "memory" | "policy-file" | "unavailable";
}

/** A queryable collection of policy entries. */
export interface PolicyCorpus {
  entries: PolicyEntry[];
  /** Number of entries that successfully loaded vs total attempted. */
  loadedCount: number;
  unavailableCount: number;
}

// ---------------------------------------------------------------------------
// Safe file read helpers
// ---------------------------------------------------------------------------

/**
 * Read a file's content, returning `null` on any error.
 *
 * Uses `Bun.file(...).text()` per project rule `bun_over_node.mdc` — the
 * test runner is `bun:test`, so Bun globals are available everywhere this
 * module runs. Wraps in try/catch so corpus loading never throws.
 */
async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await Bun.file(filePath).text();
  } catch {
    return null;
  }
}

/**
 * List directory entries, returning `[]` on any error.
 * Gracefully handles missing directories.
 */
async function safeReaddir(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath);
    return entries;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Source 1: Task spec
// ---------------------------------------------------------------------------

/**
 * Load the task spec for the given task ID.
 *
 * Uses the minsky CLI to fetch the spec (same approach as parallel-work-guard).
 * Returns `null` if the task ID is absent or the fetch fails. Synchronous —
 * `execWithPath` uses `Bun.spawnSync`.
 */
export function loadTaskSpec(taskId: string | undefined): PolicyEntry | null {
  if (!taskId) return null;

  try {
    const result = execWithPath(["minsky", "tasks", "spec", "get", taskId], {
      timeout: 5000,
    });

    if (result.exitCode !== 0 || !result.stdout.trim()) {
      return null;
    }

    return {
      source: `task-spec:${taskId}`,
      ref: `task-spec:${taskId}`,
      content: result.stdout,
      category: "task-spec",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug("corpus-loader: failed to load task spec", { taskId, error: message });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Source 2: CLAUDE.md
// ---------------------------------------------------------------------------

/**
 * Load CLAUDE.md files (project-level and user-level).
 *
 * Project-level: `<projectRoot>/CLAUDE.md` and `<projectRoot>/.claude/CLAUDE.md`
 * User-level: `~/.claude/CLAUDE.md`
 */
export async function loadClaudeMdFiles(projectRoot: string): Promise<PolicyEntry[]> {
  const entries: PolicyEntry[] = [];

  const candidates: Array<{ path: string; label: string }> = [
    { path: join(projectRoot, "CLAUDE.md"), label: "CLAUDE.md (project)" },
    { path: join(projectRoot, ".claude", "CLAUDE.md"), label: "CLAUDE.md (.claude/)" },
    { path: join(homedir(), ".claude", "CLAUDE.md"), label: "CLAUDE.md (user)" },
  ];

  for (const { path: filePath, label } of candidates) {
    const content = await safeReadFile(filePath);
    if (content !== null) {
      entries.push({
        source: label,
        ref: filePath,
        content,
        category: "claude-md",
      });
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Source 3: Project rules
// ---------------------------------------------------------------------------

/**
 * Load all rule files from `.claude/rules/` and `.minsky/rules/`.
 *
 * Includes `decision-defaults.mdc` from mt#1508 — the primary policy source.
 * MDC frontmatter is retained in the content for `alwaysApply` field parsing.
 */
export async function loadProjectRules(projectRoot: string): Promise<PolicyEntry[]> {
  const entries: PolicyEntry[] = [];

  const ruleDirs = [join(projectRoot, ".claude", "rules"), join(projectRoot, ".minsky", "rules")];

  for (const ruleDir of ruleDirs) {
    const files = await safeReaddir(ruleDir);
    for (const file of files) {
      if (!file.endsWith(".md") && !file.endsWith(".mdc") && !file.endsWith(".txt")) {
        continue;
      }
      const filePath = join(ruleDir, file);
      const content = await safeReadFile(filePath);
      if (content !== null) {
        entries.push({
          source: file,
          ref: filePath,
          content,
          category: "project-rule",
        });
      }
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Source 4: Long-lived memories
// ---------------------------------------------------------------------------

/**
 * Resolve the project memory directory path from the project root.
 *
 * Convention: `~/.claude/projects/<slug>/memory/` where `<slug>` is derived
 * from the project root path by replacing `/` with `-`.
 *
 * Example: /Users/edobry/Projects/minsky → -Users-edobry-Projects-minsky
 */
export function resolveMemoryDir(projectRoot: string): string {
  const absoluteRoot = resolve(projectRoot);
  const slug = absoluteRoot.replace(/\//g, "-");
  return join(homedir(), ".claude", "projects", slug, "memory");
}

/**
 * Load long-lived memory files matching `{feedback,project}_*.md`.
 *
 * Returns entries for each file found. Gracefully handles missing directory.
 */
export async function loadMemoryFiles(projectRoot: string): Promise<PolicyEntry[]> {
  const entries: PolicyEntry[] = [];
  const memoryDir = resolveMemoryDir(projectRoot);

  let files: string[] = [];
  try {
    files = await safeReaddir(memoryDir);
  } catch {
    return entries;
  }

  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    // Only feedback_* and project_* files per mt#1575 spec
    if (!file.startsWith("feedback_") && !file.startsWith("project_")) continue;

    const filePath = join(memoryDir, file);
    const content = await safeReadFile(filePath);
    if (content !== null) {
      entries.push({
        source: file,
        ref: filePath,
        content,
        category: "memory",
      });
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Source 5: Future .minsky/policy/*
// ---------------------------------------------------------------------------

/**
 * Load any files from `.minsky/policy/` — gracefully handles absent directory.
 *
 * This source is a forward-compatibility slot for future policy files.
 * An absent directory is not an error.
 */
export async function loadPolicyFiles(projectRoot: string): Promise<PolicyEntry[]> {
  const entries: PolicyEntry[] = [];
  const policyDir = join(projectRoot, ".minsky", "policy");

  const files = await safeReaddir(policyDir);
  for (const file of files) {
    if (!file.endsWith(".md") && !file.endsWith(".mdc") && !file.endsWith(".txt")) {
      continue;
    }
    const filePath = join(policyDir, file);
    const content = await safeReadFile(filePath);
    if (content !== null) {
      entries.push({
        source: file,
        ref: filePath,
        content,
        category: "policy-file",
      });
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Full corpus loader
// ---------------------------------------------------------------------------

/**
 * Options for `loadPolicyCorpus`.
 */
export interface CorpusLoadOptions {
  /** Project root directory. Defaults to `process.cwd()`. */
  projectRoot?: string;
  /** Task ID for source 1 (task spec). `undefined` skips task-spec lookup. */
  taskId?: string;
}

/**
 * Load all 5 policy sources and return a queryable `PolicyCorpus`.
 *
 * All I/O failures are caught and logged; unavailable sources produce
 * `PolicyEntry` records with `category: "unavailable"` rather than throwing.
 *
 * The returned corpus's `loadedCount` and `unavailableCount` track how many
 * sources successfully loaded vs failed, for calibration logging.
 */
export async function loadPolicyCorpus(options: CorpusLoadOptions = {}): Promise<PolicyCorpus> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const taskId = options.taskId;

  const allEntries: PolicyEntry[] = [];
  let unavailableCount = 0;

  // Source 1: task spec
  const taskSpec = loadTaskSpec(taskId);
  if (taskSpec !== null) {
    allEntries.push(taskSpec);
  } else if (taskId) {
    unavailableCount++;
  }

  // Source 2: CLAUDE.md files
  try {
    const claudeMdEntries = await loadClaudeMdFiles(projectRoot);
    allEntries.push(...claudeMdEntries);
    if (claudeMdEntries.length === 0) unavailableCount++;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug("corpus-loader: failed to load CLAUDE.md files", { error: message });
    unavailableCount++;
  }

  // Source 3: project rules
  try {
    const ruleEntries = await loadProjectRules(projectRoot);
    allEntries.push(...ruleEntries);
    if (ruleEntries.length === 0) unavailableCount++;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug("corpus-loader: failed to load project rules", { error: message });
    unavailableCount++;
  }

  // Source 4: memories
  try {
    const memoryEntries = await loadMemoryFiles(projectRoot);
    allEntries.push(...memoryEntries);
    // Memory dir missing is not an error (no unavailableCount bump)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug("corpus-loader: failed to load memory files", { error: message });
  }

  // Source 5: .minsky/policy/* (future)
  try {
    const policyEntries = await loadPolicyFiles(projectRoot);
    allEntries.push(...policyEntries);
    // Absent policy dir is not an error
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug("corpus-loader: failed to load policy files", { error: message });
  }

  return {
    entries: allEntries,
    loadedCount: allEntries.length,
    unavailableCount,
  };
}
