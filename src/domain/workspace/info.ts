/**
 * Workspace Info Domain Function
 *
 * Returns information about the current workspace context — whether it is a main
 * workspace or a session workspace, the resolved cwd, config path, and the active
 * backend names.  Designed to never throw even against uninitialized directories.
 */

import { existsSync } from "fs";
import { join, resolve, sep, relative, isAbsolute } from "path";
import { parse } from "yaml";
import { readFileSync } from "fs";
import { getSessionsDir } from "../../utils/paths";
import { log } from "../../utils/logger";
import type { SessionProviderInterface } from "../session/index";

export interface WorkspaceInfo {
  /** Resolved absolute path to the workspace root */
  cwd: string;
  /** True when cwd is NOT a session workspace and IS an initialised Minsky project */
  isMainWorkspace: boolean;
  /** True when cwd lives inside the Minsky sessions directory */
  isSessionWorkspace: boolean;
  /** Session UUID if this is a session workspace */
  sessionId?: string;
  /** Task ID (e.g. "mt#1168") if the session is task-associated */
  taskId?: string;
  /** Absolute path to .minsky/config.yaml when it exists */
  configPath?: string;
  /** Active tasks backend name (e.g. "minsky", "github-issues") */
  tasksBackend?: string;
  /** Active repository backend name (e.g. "github", "local") */
  repoBackend?: string;
}

/**
 * Injectable dependencies for getWorkspaceInfo.
 *
 * All fields are optional — production callers omit them (defaults are used);
 * test callers inject mocks to avoid real-filesystem and real-DB access.
 */
export interface WorkspaceInfoDeps {
  /** Session provider used to resolve taskId from sessionId. */
  sessionProvider?: SessionProviderInterface;
  /** File-system shim — production uses node:fs; tests inject fakes. */
  fileSystem?: {
    existsSync: (path: string) => boolean;
    readFileSync: (path: string, encoding: BufferEncoding) => string;
  };
}

/**
 * Detect whether `cwd` is a Minsky session workspace.
 *
 * Session workspaces live under ~/.local/state/minsky/sessions/<uuid>/.
 * We check the actual sessions dir (respecting XDG_STATE_HOME overrides) so
 * tests can inject a custom path via the environment variable.
 */
export function detectSessionWorkspace(cwd: string): {
  isSession: boolean;
  sessionId?: string;
} {
  const sessionsDir = getSessionsDir();
  const normalizedCwd = resolve(cwd);
  const normalizedSessionsDir = resolve(sessionsDir);

  // Use path.relative for separator-agnostic membership check.
  // If `relative` starts with ".." or is absolute, cwd is outside the sessions dir.
  const rel = relative(normalizedSessionsDir, normalizedCwd);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { isSession: false };
  }

  // Empty rel means cwd === sessionsDir — that's the root, not a session workspace.
  if (rel === "") {
    return { isSession: false };
  }

  // Extract first segment as sessionId using the platform path separator.
  const sessionId = rel.split(sep)[0];
  if (!sessionId) {
    return { isSession: false };
  }

  return { isSession: true, sessionId };
}

/**
 * Read the active tasks backend and repo backend from the config file at
 * `configPath`.  Returns undefined for either field when parsing fails or
 * the field is absent — never throws.
 */
function readBackendsFromConfig(
  configPath: string,
  read: (path: string, encoding: BufferEncoding) => string
): {
  tasksBackend?: string;
  repoBackend?: string;
} {
  try {
    const content = read(configPath, "utf8");
    const parsed = parse(content) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    const tasks = parsed.tasks as Record<string, unknown> | undefined;
    const repository = parsed.repository as Record<string, unknown> | undefined;

    const tasksBackend =
      (tasks?.backend as string | undefined) || (parsed.backend as string | undefined) || undefined;

    const repoBackend = (repository?.backend as string | undefined) || undefined;

    return { tasksBackend, repoBackend };
  } catch (err) {
    log.debug("workspace.info: failed to read backends from config", {
      configPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

/**
 * Return workspace information for `cwd`.
 *
 * Never throws — falls back to partial information when config is absent or
 * when the directory does not exist.
 *
 * @param cwd  - Directory to inspect. Defaults to `process.cwd()`.
 * @param deps - Injectable dependencies (session provider). Omit in production;
 *               inject mocks in tests.
 */
export async function getWorkspaceInfo(
  cwd?: string,
  deps?: WorkspaceInfoDeps
): Promise<WorkspaceInfo> {
  const resolvedCwd = resolve(cwd ?? process.cwd());

  // --- File-system shim ---
  const fs = deps?.fileSystem ?? { existsSync, readFileSync };

  // --- Session detection ---
  const { isSession, sessionId } = detectSessionWorkspace(resolvedCwd);

  // --- Config path ---
  const configPath = join(resolvedCwd, ".minsky", "config.yaml");
  const configExists = fs.existsSync(configPath);

  // --- Backends ---
  const backends = configExists ? readBackendsFromConfig(configPath, fs.readFileSync) : {};

  // --- Task ID (only relevant for session workspaces) ---
  let taskId: string | undefined;
  if (isSession && sessionId) {
    taskId = await resolveTaskIdForSession(sessionId, deps?.sessionProvider);
  }

  // A "main workspace" is an initialised Minsky project (has config.yaml) that
  // is NOT a session workspace.
  const isMainWorkspace = !isSession && configExists;

  return {
    cwd: resolvedCwd,
    isMainWorkspace,
    isSessionWorkspace: isSession,
    ...(sessionId !== undefined && { sessionId }),
    ...(taskId !== undefined && { taskId }),
    ...(configExists && { configPath }),
    ...(backends.tasksBackend !== undefined && { tasksBackend: backends.tasksBackend }),
    ...(backends.repoBackend !== undefined && { repoBackend: backends.repoBackend }),
  };
}

/**
 * Attempt to resolve the task ID for a session workspace.
 *
 * Accepts an optional pre-built provider for testability.  When no provider
 * is passed, falls back to lazy-importing createSessionProvider from the
 * composition module — callers in composition-root files (e.g. MCP server
 * startup) should pass a provider to avoid the reach-in.
 *
 * Returns undefined if the session is not found or the DB is unavailable —
 * never throws.
 */
async function resolveTaskIdForSession(
  sessionId: string,
  sessionProvider?: SessionProviderInterface
): Promise<string | undefined> {
  try {
    let provider = sessionProvider;
    if (!provider) {
      // Lazy import is acceptable here: this code path only runs at runtime
      // when no provider was injected (i.e. called outside a composition root).
      // The eslint rule is suppressed because the alternative — always requiring
      // callers to build the provider — would break the tool's "no required
      // params" contract (workspace.info takes no required parameters).
      const { createSessionProvider } = await import("../session/index");
      // eslint-disable-next-line custom/no-singleton-reach-in
      provider = await createSessionProvider();
    }
    const record = await provider.getSession(sessionId);
    if (record?.taskId) {
      // Normalise: storage uses plain "1168", callers expect "mt#1168"
      const raw = record.taskId;
      return raw.startsWith("mt#") ? raw : `mt#${raw}`;
    }
    return undefined;
  } catch {
    // Session DB may be unavailable (e.g., test fixture); return undefined
    return undefined;
  }
}
