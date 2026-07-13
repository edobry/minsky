/**
 * Canonical session file-edit apply-model operation (mt#2612).
 *
 * Extracted from `src/adapters/mcp/session-edit-tools.ts`'s `session.edit_file`
 * handler so both entry points — the MCP tool (`session.edit_file`) and the CLI
 * command (`session.edit-file`, `src/adapters/shared/commands/session/file-commands.ts`)
 * — share one implementation of the Cursor-style apply-model semantics, including
 * the mt#2400 FAIL-CLOSED guard.
 *
 * Decision flow:
 *   1. Resolve the session-relative path to an absolute, boundary-checked path.
 *   2. Determine whether the target file already exists (and read it if so).
 *   3. Detect `// ... existing code ...` markers in the supplied content.
 *   4. Refuse (a) marker content against a non-existent file, and (b) marker-less
 *      content against an EXISTING file unless the caller explicitly opts in via
 *      `fullReplace` (the mt#2400 FAIL-CLOSED guard).
 *   5. Apply the edit pattern (via the injectable `applyEditPattern`) when both a
 *      marker and an existing file are present; otherwise write the content directly
 *      (new file, or an explicit full replacement).
 *   6. In dry-run mode, stop before any filesystem write and report `wrote: false`.
 *      Otherwise create parent directories (if requested) and write the file.
 *
 * Diff/response-envelope formatting is intentionally OUT of scope for this
 * function — `@minsky/domain` only depends on `@minsky/shared`, and the diff
 * utilities (`src/utils/diff.ts`) live in the outer application. Each adapter
 * builds its own diff/response shape from the returned
 * `SessionFileEditOperationResult`.
 */
import { stat, writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import { readTextFile } from "@minsky/shared/fs";
import { hasExistingCodeMarkers } from "../ai/edit-pattern-utils";
import { applyEditPattern as defaultApplyEditPattern } from "../ai/edit-pattern-service";
import { SessionPathResolver, type SessionProviderInput } from "./session-path-resolver";

/**
 * Input arguments for {@link applySessionFileEditOperation}.
 */
export interface SessionFileEditOperationArgs {
  /** Session ID / identifier used to resolve the workspace root. */
  sessionId: string;
  /** Path to the file, relative to the session workspace (or absolute within it). */
  path: string;
  /** Edit content — either a full replacement, or a pattern using `// ... existing code ...` markers. */
  content: string;
  /** Optional high-level instruction passed through to the AI apply-model provider. */
  instructions?: string;
  /** Preview the change without writing to disk. Defaults to false. */
  dryRun?: boolean;
  /** Create parent directories if they don't exist. Defaults to false (caller decides). */
  createDirs?: boolean;
  /**
   * Override the mt#2400 FAIL-CLOSED guard: allow marker-less content to
   * intentionally replace an existing file's content in full. Defaults to false.
   */
  fullReplace?: boolean;
  /** Optional session-provider input threaded through to `SessionPathResolver`. */
  sessionProvider?: SessionProviderInput;
}

/**
 * Injectable dependencies for {@link applySessionFileEditOperation}.
 *
 * `applyEditPattern` is DI-injectable (mirrors `applyEditPattern`'s own
 * `dependencies?: { config }` convention) so tests can supply a deterministic
 * fake instead of driving a real AI provider — `mock.module()` is banned
 * outside `tests/setup.ts` (see `no-global-module-mocks` ESLint rule).
 */
export interface SessionFileEditOperationDeps {
  applyEditPattern?: typeof defaultApplyEditPattern;
}

/**
 * Result of a session file-edit operation.
 */
export interface SessionFileEditOperationResult {
  /** Absolute, boundary-checked path the operation resolved to. */
  resolvedPath: string;
  /** Whether the target file existed before this operation. */
  fileExisted: boolean;
  /** The file's content before this operation (empty string for new files). */
  originalContent: string;
  /** The content that was written (or would be written, in dry-run mode). */
  finalContent: string;
  /** Whether the file was actually written to disk (false in dry-run mode). */
  wrote: boolean;
}

/**
 * Apply the canonical session file-edit apply-model operation.
 *
 * @throws Error when marker content targets a non-existent file, or when
 *   marker-less content targets an existing file without `fullReplace: true`
 *   (mt#2400 FAIL-CLOSED guard).
 */
export async function applySessionFileEditOperation(
  args: SessionFileEditOperationArgs,
  deps?: SessionFileEditOperationDeps
): Promise<SessionFileEditOperationResult> {
  const applyEditPattern = deps?.applyEditPattern ?? defaultApplyEditPattern;

  const pathResolver = new SessionPathResolver(args.sessionProvider);
  const resolvedPath = await pathResolver.resolvePath(args.sessionId, args.path);

  let fileExisted = false;
  let originalContent = "";

  try {
    await stat(resolvedPath);
    fileExisted = true;
    originalContent = await readTextFile(resolvedPath);
  } catch (_error) {
    // File doesn't exist — that's ok for new files.
    fileExisted = false;
  }

  const hasMarkers = hasExistingCodeMarkers(args.content);

  // If the file doesn't exist and we have existing-code markers, that's an error.
  if (!fileExisted && hasMarkers) {
    throw new Error(
      `Cannot apply edits with existing code markers to non-existent file: ${args.path}`
    );
  }

  // mt#2400 fail-closed guard: editing an EXISTING file with marker-less
  // content routes to a direct full-file overwrite (the silent
  // content-destruction family — R3, mt#2211). Refuse unless the caller
  // explicitly opts into a full replacement via fullReplace.
  if (fileExisted && !hasMarkers && !args.fullReplace) {
    throw new Error(
      `Refusing to apply marker-less content to existing file "${args.path}": this would silently overwrite the entire file. ` +
        `Add '// ... existing code ...' markers around the changed region for a partial edit, ` +
        `or use session_write_file (or pass fullReplace=true) for an intentional full replacement.`
    );
  }

  let finalContent: string;

  if (fileExisted && hasMarkers) {
    // Apply the edit pattern using fast-apply providers, passing optional instruction.
    finalContent = await applyEditPattern(originalContent, args.content, args.instructions);
  } else {
    // Direct write for new files, or an explicit full replacement (fullReplace=true).
    finalContent = args.content;
  }

  if (args.dryRun) {
    return { resolvedPath, fileExisted, originalContent, finalContent, wrote: false };
  }

  if (args.createDirs) {
    const parentDir = dirname(resolvedPath);
    await mkdir(parentDir, { recursive: true });
  }

  await writeFile(resolvedPath, finalContent, "utf8");

  return { resolvedPath, fileExisted, originalContent, finalContent, wrote: true };
}
