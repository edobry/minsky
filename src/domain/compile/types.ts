/**
 * Compile Pipeline Types
 *
 * Shared interfaces for the Minsky compile pipeline. Targets read TypeScript
 * definition modules and emit harness-specific output files.
 */

export interface MinskyTargetOptions {
  /** Override output directory (default: target-specific) */
  outputPath?: string;
  /**
   * When true, compute output without writing files.
   * Targets MUST populate `content` and/or `contentsByPath` on the result.
   */
  dryRun?: boolean;
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
