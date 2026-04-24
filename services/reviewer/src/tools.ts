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

export interface ReviewerToolContext {
  /**
   * Read the content of a file at the PR's HEAD ref. Path is relative to the
   * repository root. Returns null if the file does not exist.
   */
  readFile(path: string): Promise<string | null>;

  /**
   * List immediate children (files and directories) of a directory at the
   * PR's HEAD ref. Path is relative to the repository root. Returns null if
   * the directory does not exist.
   */
  listDirectory(path: string): Promise<Array<{ name: string; type: "file" | "dir" }> | null>;
}
