/**
 * Repository Resolution
 *
 * Functions for resolving repository references to canonical URIs.
 * Extracted from the parent repository.ts file.
 */
import { normalizeRepositoryUri, UriFormat } from "../uri-utils";
import { createSessionProvider } from "../session";
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
 * DEFAULT_RETRY_COUNT. Otherwise throw an error
 *
 * @param options Resolution options
 * @returns Resolved repository information
 * @throws ValidationError if repository cannot be resolved
 */
export async function resolveRepository(
  options: RepositoryResolutionOptions = {}
): Promise<ResolvedRepository> {
  const { uri, session, taskId, autoDetect = true, cwd = getCurrentWorkingDirectory() } = options;

  let repositoryUri: string | undefined;
  let backendType = RepositoryBackendType.LOCAL;

  // 1. Try to resolve from explicit URI
  if (uri) {
    repositoryUri = uri;
  }
  // 2. Try to resolve from session
  else if (session) {
    const sessionDb = await createSessionProvider();
    const sessionRecord = await sessionDb.getSession(session);
    if (!sessionRecord) {
      throw new ValidationError(`Session not found: ${session}`);
    }
    repositoryUri = sessionRecord.repoUrl;
    backendType =
      (sessionRecord.backendType as RepositoryBackendType) || RepositoryBackendType.LOCAL;
  }
  // 3. Try to resolve from task ID
  else if (taskId) {
    const validatedTaskId = taskId.startsWith("#") ? taskId : `#${taskId}`;
    const sessionDb = await createSessionProvider();
    const sessionRecord = await sessionDb.getSessionByTaskId(validatedTaskId);
    if (!sessionRecord) {
      throw new ValidationError(`No session found for task: ${taskId}`);
    }
    repositoryUri = sessionRecord.repoUrl;
    backendType =
      (sessionRecord.backendType as RepositoryBackendType) || RepositoryBackendType.LOCAL;
  }
  // 4. Try auto-detection from current directory
  else if (autoDetect) {
    repositoryUri = await detectRepositoryFromCwd(cwd);
    if (!repositoryUri) {
      throw new ValidationError("No Git repository found in current directory");
    }
  }
  // DEFAULT_RETRY_COUNT. No resolution method available
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

    // Determine backend type based on URI format
    if (normalized.isLocal) {
      backendType = RepositoryBackendType.LOCAL;
    } else {
      // Default to GITHUB for remote repositories unless specified otherwise
      if (backendType === RepositoryBackendType.LOCAL) {
        backendType = RepositoryBackendType.GITHUB;
      }
    }

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
    throw new MinskyError(`Failed to resolve repository _path: ${getErrorMessage(error as any)}`);
  }
}
