/**
 * Reviewer tool context interface and related types.
 *
 * Defines the tool surface exposed to the model during review so it can verify
 * cross-file claims without hallucinating. The model receives read-only access
 * to the repository at the PR's HEAD ref.
 *
 * Tool support per provider (mt#1126 MVP):
 *   - OpenAI: full tool-use loop (function calling)
 *   - Google: falls back to no-tools path with a warning log
 *   - Anthropic: falls back to no-tools path with a warning log
 */

import type { DirEntry, ReadFileResult } from "./github-client";

export type { DirEntry, DirEntryType, ReadFileResult } from "./github-client";

export interface ReviewerToolContext {
  /**
   * Read the content of a file at the PR's HEAD ref. Path is relative to the
   * repository root. Returns null if the file does not exist (404).
   *
   * Text files return `{ kind: "text", content, truncated }`; binary files
   * (null byte in first 8KB) return `{ kind: "binary", size }` so the model
   * doesn't burn context on UTF-8-decoded garbage (mt#1216).
   */
  readFile(path: string): Promise<ReadFileResult | null>;

  /**
   * List immediate children of a directory at the PR's HEAD ref. Path is
   * relative to the repository root. Returns null if the directory does not
   * exist (404). Entries include `file`, `dir`, `symlink`, and `submodule`
   * types (mt#1216).
   */
  listDirectory(path: string): Promise<DirEntry[] | null>;
}
