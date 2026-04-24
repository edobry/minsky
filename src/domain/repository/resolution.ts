/**
 * Repository Resolution
 *
 * Functions for resolving repository references to canonical URIs.
 * Extracted from the parent repository.ts file.
 */
import { normalizeRepositoryUri, UriFormat } from "../uri-utils";
import type { SessionProviderInterface } from "../session";
import { getCurrentWorkingDirectory } from "../../utils/process";
import { ValidationError, MinskyError, getErrorMessage } from "../../errors/index";
import { log } from "../../utils/logger";
import { detectRepositoryFromCwd } from "../uri-utils";
import { RepositoryBackendType } from "./legacy-types";
import type { RepositoryResolutionOptions, ResolvedRepository } from "./legacy-types";

/**
 * Resolves a repository reference to a canonical URI and normalized name.
 *
 * Resolution strategy:
 * 1. If explicit URI is provided, use it
 * 2. If session is specified, get repository from the session
 * 3. If task ID is specified, find the associated session's repository
 * 4. If auto-detection is enabled, try to find repository from current directory
 * 5. Otherwise throw an error
 *
 * @param options Resolution options
 * @returns Resolved repository information
 * @throws ValidationError if repository cannot be resolved
 */
export async function resolveRepository(
  options: RepositoryResolutionOptions = {},
  deps?: { sessionDB: SessionProviderInterface }
): Promise<ResolvedRepository> {
  const { uri, session, taskId, autoDetect = true, cwd = getCurrentWorkingDirectory() } = options;

  let repositoryUri: string | undefined;
  let backendType = RepositoryBackendType.GITHUB;

  // 1. Try to resolve from explicit URI
  if (uri) {
    repositoryUri = uri;
  }
  // 2. Try to resolve from session
  else if (session) {
    if (!deps?.sessionDB) {
      throw new ValidationError("sessionDB dependency is required when resolving by session");
    }
    const sessionRecord = await deps.sessionDB.getSession(session);
    if (!sessionRecord) {
      throw new ValidationError(`Session not found: ${session}`);
    }
    repositoryUri = sessionRecord.repoUrl;
    backendType = RepositoryBackendType.GITHUB;
  }
  // 3. Try to resolve from task ID
  else if (taskId) {
    if (!deps?.sessionDB) {
      throw new ValidationError("sessionDB dependency is required when resolving by task ID");
    }
    const validatedTaskId = taskId.startsWith("#") ? taskId : `#${taskId}`;
    const sessionRecord = await deps.sessionDB.getSessionByTaskId(validatedTaskId);
    if (!sessionRecord) {
      throw new ValidationError(`No session found for task: ${taskId}`);
    }
    repositoryUri = sessionRecord.repoUrl;
    backendType = RepositoryBackendType.GITHUB;
  }
  // 4. Try auto-detection from current directory
  else if (autoDetect) {
    repositoryUri = await detectRepositoryFromCwd(cwd);
    if (!repositoryUri) {
      throw new ValidationError("No Git repository found in current directory");
    }
  }
  // 5. No resolution method available
  else {
    throw new ValidationError(
      "Cannot resolve repository: no URI, session, or task ID provided, and auto-detection is disabled"
    );
  }

  // Normalize the repository URI
  try {
    const normalized = normalizeRepositoryUri(repositoryUri as string, {
      validateLocalExists: true,
      ensureFullyQualified: true,
    });

    // All repositories use the GitHub backend
    backendType = RepositoryBackendType.GITHUB;

    // For local repositories, extract the path
    let path: string | undefined;
    if (normalized.isLocal) {
      path =
        normalized.format === UriFormat.FILE
          ? normalized.uri.replace(/^file:\/\//, "")
          : normalized.uri;
    }

    return {
      uri: normalized.uri,
      name: normalized.name,
      isLocal: normalized.isLocal,
      path,
      backendType,
      format: normalized.format,
    };
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }
    throw new ValidationError(`Invalid repository URI: ${repositoryUri}`);
  }
}

/**
 * Deprecated: Use resolveRepository instead.
 * This is kept for backward compatibility.
 */
export async function resolveRepoPath(options: {
  session?: string;
  repo?: string;
}): Promise<string> {
  log.warn("resolveRepoPath is deprecated. Use resolveRepository instead.");

  try {
    const repository = await resolveRepository({
      uri: options.repo,
      session: options.session,
      autoDetect: true,
    });

    if (repository.isLocal) {
      return repository.path || "";
    } else {
      // For backward compatibility, return the URI for remote repositories
      return repository.uri;
    }
  } catch (error) {
    throw new MinskyError(`Failed to resolve repository _path: ${getErrorMessage(error)}`);
  }
}
