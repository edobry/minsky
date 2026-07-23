/**
 * Compile Pipeline Types
 *
 * Shared interfaces for the Minsky compile pipeline. Targets read TypeScript
 * definition modules and emit harness-specific output files.
 */

import type { MemoryLoadingMode } from "../configuration/schemas/memory";
import type { SizeBudget } from "./size-budget";

export interface MinskyTargetOptions {
  /** Override output directory (default: target-specific) */
  outputPath?: string;
  /**
   * When true, compute output without writing files.
   * Targets MUST populate `content` and/or `contentsByPath` on the result.
   */
  dryRun?: boolean;
  /**
   * Controls whether the memory-usage directive is emitted in `claude.md`
   * (mt#2992, threaded from the legacy `TargetOptions.memoryLoadingMode`).
   * - `"on_demand"` (default): emit the directive so the agent calls
   *   `memory_search`.
   * - `"legacy"`: suppress the directive; relies on the MEMORY.md preamble
   *   loader.
   * Only the `claude.md` target reads this — other targets ignore it.
   */
  memoryLoadingMode?: MemoryLoadingMode;
  /**
   * Per-call override of a target's default size budget (mt#2802, threaded
   * into the new pipeline in mt#2992). Either field may be supplied
   * independently; an absent field falls back to the target's default. Only
   * `claude.md` and `agents.md` currently enforce a size budget — other
   * targets ignore this option.
   */
  sizeBudget?: Partial<SizeBudget>;
}

export interface MinskyCompileResult {
  /** Target identifier */
  target: string;
  /** Absolute paths of files written (or would-be-written in dry-run) */
  filesWritten: string[];
  /** Names of definitions successfully compiled */
  definitionsIncluded: string[];
  /** Names of definitions skipped (e.g. validation failure) */
  definitionsSkipped: string[];
  /**
   * Dry-run content.
   * - Single-file targets: the full file content.
   * - Multi-file targets: a concatenated summary (for display only).
   * Use `contentsByPath` for per-file comparison.
   */
  content?: string;
  /**
   * Per-file content map for multi-file targets in dry-run mode.
   * Keys are absolute file paths matching `filesWritten`.
   */
  contentsByPath?: Map<string, string>;
}

/**
 * Injectable fs subset used by staleness checks and target writes.
 *
 * Keeps the real `fs/promises` out of unit-test hot paths — tests
 * inject a fake object satisfying this interface instead.
 *
 * Pattern: `realFs as MinskyCompileFsDeps` at the call site.
 * See src/domain/rules/operations/migration-operations.ts:30 for precedent.
 */
export interface MinskyCompileFsDeps {
  readFile(path: string, encoding: "utf-8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf-8"): Promise<void>;
  mkdir(path: string, options: { recursive: boolean }): Promise<string | undefined>;
  readdir(path: string): Promise<string[]>;
  access(path: string): Promise<void>;
  /** Set file permissions (mode). Used by claude-hooks to enforce 0o755. */
  chmod(path: string, mode: number): Promise<void>;
  /**
   * Remove a file. OPTIONAL (mt#2992) — only `claude-rules`'s stale-file
   * removal needs it; kept optional rather than required so the fake-fs
   * fixtures in the other new-pipeline targets' existing tests
   * (claude-skills/claude-agents/cursor-rules-ts/claude-hooks) don't need to
   * grow an unused method just to keep satisfying this interface.
   */
  unlink?(path: string): Promise<void>;
}

/**
 * A compile target transforms TypeScript definition modules into
 * harness-specific output files.
 */
export interface MinskyCompileTarget {
  /** Machine identifier, e.g. "claude-skills" */
  id: string;
  /** Human-readable display name, e.g. "Claude Skills" */
  displayName: string;

  /**
   * When true, the output directory is shared with hand-authored content (e.g.
   * `.claude/skills/` contains both compiled and hand-authored SKILL.md files),
   * so orphan detection during --check is skipped to avoid false positives.
   * Default: false (the target exclusively owns its output directory).
   */
  sharedOutputDirectory?: boolean;

  /** Returns the default output directory for this target. */
  defaultOutputPath(workspacePath: string): string;

  /**
   * Compile all definitions under workspacePath and write output files.
   * When fsDeps is provided the target uses it instead of real fs (test seam).
   *
   * Targets may also accept `{ dryRun: true }` mixed into options — when
   * dryRun is true they must NOT write files and MUST populate `content`
   * and/or `contentsByPath` on the result for staleness comparison.
   */
  compile(
    options: MinskyTargetOptions,
    workspacePath: string,
    fsDeps?: MinskyCompileFsDeps
  ): Promise<MinskyCompileResult>;

  /**
   * Return the list of all output file paths this target would produce.
   * Used for staleness detection in --check mode.
   */
  listOutputFiles(
    options: MinskyTargetOptions,
    workspacePath: string,
    fsDeps?: MinskyCompileFsDeps
  ): Promise<string[]>;
}
