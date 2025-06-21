/**
 * URI utilities for repository and session resolution.
 * Provides functions for normalizing, validating, and converting repository URIs.
 */
import { existsSync } from "fs";
import { basename } from "path";
import { ValidationError } from "../errors/index.js";
/**
 * Supported repository URI formats
 */
export enum UriFormat {
  HTTPS = "https",
  SSH = "ssh",
  FILE = "file",
  PATH = "path",
  SHORTHAND = "shorthand",
}

/**
 * Represents a normalized repository reference
 */
export interface RepositoryUri {
  /**
   * The canonical URI for the repository
   */
  uri: string;

  /**
   * The normalized name derived from the URI (org/repo or local/repo)
   */
  name: string;

  /**
   * The format of the original URI
   */
  format: UriFormat;

  /**
   * Whether this is a local repository
   */
  isLocal: boolean;
}

/**
 * Options for URI normalization and validation
 */
export interface UriOptions {
  /**
   * Whether to validate that local paths exist on the filesystem
   */
  validateLocalExists?: boolean;

  /**
   * Whether to ensure the URI is fully qualified
   */
  ensureFullyQualified?: boolean;
}

/**
 * Default options for URI operations
 */
const DEFAULT_URI_OPTIONS: UriOptions = {
  validateLocalExists: true,
  ensureFullyQualified: true,
};

/**
 * Normalizes a repository URI to a canonical form and extracts the repository name.
 *
 * Supported formats:
 * - HTTPS URLs: https://github.com/org/repo.git
 * - SSH URLs: git@github.com:org/repo.git
 * - Local paths with file:// schema: file:///path/to/repo
 * - Plain filesystem paths: /path/to/repo
 * - GitHub shorthand: org/repo
 *
 * @param uri The repository URI to normalize
 * @param options Options for normalization behavior
 * @returns A normalized repository URI object
 * @throws ValidationError if the URI is invalid or doesn't meet requirements
 */
export function normalizeRepositoryUri(
  uri: string,
  options: UriOptions = DEFAULT_URI_OPTIONS
): RepositoryUri {
  if (!uri) {
    throw new ValidationError("Repository URI cannot be empty");
  }

  const { validateLocalExists = true, ensureFullyQualified = true } = options;

  // Default to unknown format, we'll determine it below
  let format = UriFormat.PATH;
  let normalizedUri = uri.trim();
  let normalizedName = "";
  let isLocal = false;

  // 1. Handle HTTPS URLs
  if (normalizedUri.startsWith("https://")) {
    format = UriFormat.HTTPS;
    // Extract org/repo from the URL
    const match = normalizedUri.match(/https:\/\/[^\/]+\/([^\/]+)\/([^\/]+?)(\.git)?$/);
    if (!match || !match[1] || !match[2]) {
      throw new ValidationError(`Invalid HTTPS repository URL: ${uri}`);
    }

    const org = match[1];
    const repo = match[2].replace(/\.git$/, "");
    normalizedName = `${org}/${repo}`;
    // Remove .git suffix for consistency
    normalizedUri = normalizedUri.replace(/\.git$/, "");
  }
  // 2. Handle SSH URLs
  else if (normalizedUri.includes("@") && normalizedUri.includes(":")) {
    format = UriFormat.SSH;
    // Extract org/repo from the URL
    const match = normalizedUri.match(/[^@]+@[^:]+:([^\/]+)\/([^\/]+?)(\.git)?$/);
    if (!match || !match[1] || !match[2]) {
      throw new ValidationError(`Invalid SSH repository URL: ${uri}`);
    }

    const org = match[1];
    const repo = match[2].replace(/\.git$/, "");
    normalizedName = `${org}/${repo}`;
    // Remove .git suffix for consistency
    normalizedUri = normalizedUri.replace(/\.git$/, "");
  }
  // 3. Handle local file:// URIs
  else if (normalizedUri.startsWith("file://")) {
    format = UriFormat.FILE;
    isLocal = true;
    // Extract local path
    const path = normalizedUri.replace(/^file:\/\//, "");
    // For local repos, use local/<basename> as the name
    normalizedName = `local/${basename(path)}`;

    // Validate that the path exists if requested
    if (validateLocalExists && !existsSync(path)) {
      throw new ValidationError(`Local repository does not exist: ${path}`);
    }
  }
  // 4. Handle plain filesystem paths
  else if (normalizedUri.startsWith("/") || normalizedUri.match(/^[A-Z]:\\/i)) {
    format = UriFormat.PATH;
    isLocal = true;
    // For local repos, use local/<basename> as the name
    normalizedName = `local/${basename(normalizedUri)}`;

    // Validate that the path exists if requested
    if (validateLocalExists && !existsSync(normalizedUri)) {
      throw new ValidationError(`Local repository does not exist: ${normalizedUri}`);
    }

    // Convert to file:// URI if requested
    if (ensureFullyQualified) {
      normalizedUri = `file://${normalizedUri}`;
      format = UriFormat.FILE;
    }
  }
  // 5. Handle GitHub shorthand notation (org/repo)
  else if (normalizedUri.match(/^[^\/]+\/[^\/]+$/)) {
    format = UriFormat.SHORTHAND;
    // Shorthand is already in org/repo format
    normalizedName = normalizedUri;

    // Expand to full HTTPS URL if requested
    if (ensureFullyQualified) {
      normalizedUri = `https://github.com/${normalizedUri}`;
      format = UriFormat.HTTPS;
    }
  }
  // No recognized format
  else {
    throw new ValidationError(`Unrecognized repository URI format: ${uri}`);
  }

  return {
    uri: normalizedUri,
    name: normalizedName,
    format,
    isLocal,
  };
}

/**
 * Validates that a repository URI is syntactically valid and meets requirements.
 *
 * @param uri The repository URI to validate
 * @param options Validation options
 * @returns True if the URI is valid, throws an error otherwise
 * @throws ValidationError if the URI is invalid
 */
export function validateRepositoryUri(
  uri: string,
  options: UriOptions = DEFAULT_URI_OPTIONS
): boolean {
  // This will throw if validation fails
  normalizeRepositoryUri(uri, options);
  return true;
}

/**
 * Converts a repository URI to a different format.
 *
 * @param uri The repository URI to convert
 * @param targetFormat The target format to convert to
 * @returns The URI in the target format
 * @throws ValidationError if the URI cannot be converted to the target format
 */
export function convertRepositoryUri(_uri: string, targetFormat: UriFormat): string {
  // First normalize the URI to get the repository name
  const normalized = normalizeRepositoryUri(uri);

  // If it's already in the target format, return as is
  if (normalized.format === targetFormat) {
    return normalized.uri;
  }

  // Local repositories can only be converted between PATH and FILE formats
  if (normalized.isLocal) {
    if (targetFormat === UriFormat.PATH) {
      return normalized.uri.replace(/^file:\/\//, "");
    }
    if (targetFormat === UriFormat.FILE) {
      return normalized.uri.startsWith("file://") ? normalized.uri : `file://${normalized.uri}`;
    }
    throw new ValidationError(`Cannot convert local repository to ${targetFormat} format`);
  }

  // GitHub repositories can be converted between formats
  const [org, repo] = normalized.name.split("/");

  switch (targetFormat) {
  case UriFormat.HTTPS:
    return `https://github.com/${org}/${repo}`;
  case UriFormat.SSH:
    return `git@github.com:${org}/${repo}.git`;
  case UriFormat.SHORTHAND:
    return `${org}/${repo}`;
  default:
    throw new ValidationError(`Cannot convert remote repository to ${targetFormat} format`);
  }
}

/**
 * Extracts repository information from a Git repository URL.
 *
 * @param url The repository URL
 * @returns Repository information (owner, repo)
 * @throws ValidationError if the URL cannot be parsed
 */
export function extractRepositoryInfo(_url: string): { owner: string; repo: string } {
  const normalized = normalizeRepositoryUri(url);
  const [owner, repo] = normalized.name.split("/");

  if (!owner || !repo) {
    throw new ValidationError(`Could not extract owner/repo from URL: ${url}`);
  }

  return { owner, repo };
}

/**
 * Detects a Git repository from the current directory.
 *
 * @param cwd Current working directory (defaults to process.cwd())
 * @returns The repository path if found, undefined otherwise
 */
export async function detectRepositoryFromCwd(cwd?: string): Promise<string | undefined> {
  try {
    // This will be implemented with actual Git detection code
    // For now, provide a placeholder implementation
    const { execAsync } = await import("../utils/exec.js");
    const { stdout } = await execAsync("git rev-parse --show-toplevel", { cwd });
    return stdout.trim();
  } catch (___error) {
    // Not in a Git repository
    return undefined;
  }
}
