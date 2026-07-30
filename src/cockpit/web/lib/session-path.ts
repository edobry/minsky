/**
 * Recognition of Minsky session-workspace file paths in tool-call inputs
 * (mt#3378).
 *
 * A file operation performed inside a session workspace arrives in the
 * transcript one of two ways:
 *
 *   - an MCP `session_*` file tool, carrying `sessionId` + a session-RELATIVE
 *     `path` (the tool's parameter contract — `SessionFileOperationSchema`);
 *   - a harness-native tool (`Read`/`Write`/`Edit`/`NotebookEdit`), carrying an
 *     ABSOLUTE path under the session root and no session identity at all.
 *
 * The second shape is what this module exists for. An absolute session path
 * spends ~79 leading characters on `<state-dir>/sessions/<uuid>/` before the
 * informative part begins, so a naive first-N truncation renders a summary
 * line that identifies neither the file nor the session. Splitting the path
 * lets the display show the session-relative part (what the operator reads)
 * and keep the session identity for the tooltip.
 *
 * @see ./tool-summary.ts — digest consumer
 * @see ../components/ConversationElementRenderers.tsx — label/tooltip consumer
 */
import { parseToolName } from "./tool-name";

/**
 * Absolute Minsky session-workspace path, e.g.
 * `/Users/x/.local/state/minsky/sessions/<uuid>/src/foo.ts`.
 *
 * Deliberately a DUPLICATE of `SESSION_WORKSPACE_PATH_RE` in
 * `packages/domain/src/transcripts/tool-call-projection-fields.ts` rather than
 * a shared import: that file already documents this exact precedent for the
 * `parseToolName` regex it likewise duplicates — `packages/domain` cannot
 * depend on the cockpit frontend bundle, and a five-line regex is cheaper to
 * mirror than a cross-module dependency is to carry. Keep the two in sync.
 *
 * Shape-matched rather than resolved against the real state directory: this
 * runs in the browser bundle, which has no filesystem, no `homedir()`, and no
 * `XDG_STATE_HOME`. The 36-char id segment is what makes the match specific —
 * an ordinary directory named `sessions/` does not match unless its child is
 * also a UUID-shaped name.
 *
 * The id class is deliberately loose (`[0-9a-fA-F-]{36}`, matching the domain
 * regex) rather than a canonical `8-4-4-4-12` UUID pattern: this drives a
 * DISPLAY choice, so the cost of over-matching is one cosmetically-shortened
 * path, while the cost of under-matching is the unreadable line this module
 * exists to fix. Loose-and-in-sync beats strict-and-diverged here.
 */
const SESSION_WORKSPACE_PATH_RE = /^(\/[^\s"']*\/sessions)\/([0-9a-fA-F-]{36})\/(.+)$/;

/** Input keys a path-taking file tool may carry its target under. */
const PATH_KEYS = ["file_path", "path", "filePath", "notebook_path"] as const;

/**
 * Native (non-`session_*`) file tools. These name no session in their input,
 * so a session-scoped call by one of them is only recognizable from the path —
 * and only they need the display label to say so, since a `session_*` tool
 * already announces it in its own name.
 */
const NATIVE_PATH_TOOLS = new Set(["Read", "Write", "Edit", "NotebookEdit"]);

/** A tool call's file target, resolved against the session-workspace root. */
export interface SessionWorkspaceTarget {
  /** The session (workspace) id owning the file. */
  sessionId: string;
  /** Path within the session workspace — what the operator actually reads. */
  relativePath: string;
  /** The original absolute path, preserved for the tooltip. */
  absolutePath: string;
}

/**
 * Split an absolute session-workspace path into its session id and the
 * session-relative remainder. Returns null for any path that is not shaped
 * like a session-workspace path (a main-workspace path, `/tmp`, a relative
 * path, or a `sessions/` directory whose child is not id-shaped).
 */
export function parseSessionWorkspacePath(path: string): SessionWorkspaceTarget | null {
  const m = SESSION_WORKSPACE_PATH_RE.exec(path);
  if (!m) return null;
  const sessionId = m[2];
  const relativePath = m[3];
  if (!sessionId || !relativePath) return null;
  return { sessionId, relativePath, absolutePath: path };
}

/** Read whichever path key a file-tool input carries its target under. */
export function toolInputPath(input: unknown): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Resolve a tool call's session-workspace file target, if it has one.
 *
 * `labelAsSession` distinguishes the two shapes described in the module doc:
 * true for a native tool that only reveals its session-scoping through the
 * path (the display adds a session marker), false for a `session_*` tool whose
 * name already carries it.
 */
export function sessionFileTargetFor(
  rawName: string,
  input: unknown
): (SessionWorkspaceTarget & { labelAsSession: boolean }) | null {
  const path = toolInputPath(input);
  if (!path) return null;
  const target = parseSessionWorkspacePath(path);
  if (!target) return null;
  const { name } = parseToolName(rawName);
  return { ...target, labelAsSession: NATIVE_PATH_TOOLS.has(name) };
}
