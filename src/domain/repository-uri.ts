import { basename, join } from "path";
import { existsSync } from "fs";

/**
 * Repository URI types supported by the system
 */
export enum RepositoryURIType {
  HTTPS = "https",
  SSH = "ssh",
  LOCAL_FILE = "file",
  LOCAL_PATH = "path",
  GITHUB_SHORTHAND = "github"
}

/**
 * Parsed components of a repository URI
 */
export interface RepositoryURIComponents {
  type: RepositoryURIType;
  scheme?: string;
  host?: string;
  owner?: string;
  repo?: string;
  path?: string;
  normalized: string;
  original: string;
}

/**
 * URI validation result
 */
export interface URIValidationResult {
  valid: boolean;
  error?: string;
  components?: RepositoryURIComponents;
}

/**
 * Parse a repository URI into its components
 * 
 * @param uri Repository URI to parse
 * @returns Parsed URI components
 */
export function parseRepositoryURI(uri: string): RepositoryURIComponents {
  // Handle file:// URLs
  if (uri.startsWith("file://")) {
    const path = uri.replace(/^file:\/\//, "");
    return {
      type: RepositoryURIType.LOCAL_FILE,
      scheme: "file",
      path,
      normalized: `local/${basename(path)}`,
      original: uri
    };
  }
  
  // Handle SSH URLs (git@github.com:org/repo.git)
  if (uri.includes("@") && uri.includes(":")) {
    const match = uri.match(/^([^@]+)@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (match && match.length >= 5) {
      const [, , host, owner, repo] = match;
      return {
        type: RepositoryURIType.SSH,
        scheme: "ssh",
        host,
        owner,
        repo: repo?.replace(/\.git$/, "") || "",
        normalized: `${owner}/${repo?.replace(/\.git$/, "") || ""}`,
        original: uri
      };
    }
  }
  
  // Handle HTTPS URLs (https://github.com/org/repo.git)
  if (uri.includes("://")) {
    try {
      const url = new URL(uri);
      const pathParts = url.pathname.split("/").filter(Boolean);
      
      if (pathParts.length >= 2) {
        const owner = pathParts[0] ?? "";
        const repo = (pathParts[1] ?? "").replace(/\.git$/, "");
        
        return {
          type: RepositoryURIType.HTTPS,
          scheme: url.protocol.replace(/:$/, ""),
          host: url.hostname,
          owner,
          repo,
          normalized: `${owner}/${repo}`,
          original: uri
        };
      }
    } catch (error) {
      // Invalid URL, continue to other parsing methods
    }
  }
  
  // Handle GitHub shorthand (org/repo)
  if (uri.includes("/") && !uri.includes("://") && !uri.startsWith("/")) {
    const parts = uri.split("/");
    if (parts.length === 2) {
      return {
        type: RepositoryURIType.GITHUB_SHORTHAND,
        owner: parts[0] ?? "",
        repo: (parts[1] ?? "").replace(/\.git$/, ""),
        normalized: uri.replace(/\.git$/, ""),
        original: uri
      };
    }
  }
  
  // Handle local filesystem paths
  return {
    type: RepositoryURIType.LOCAL_PATH,
    path: uri,
    normalized: `local/${basename(uri)}`,
    original: uri
  };
}

/**
 * Normalize a repository URI to a standardized format
 * 
 * @param uri Repository URI to normalize
 * @returns Normalized repository identifier
 */
export function normalizeRepositoryURI(uri: string): string {
  const components = parseRepositoryURI(uri);
  return components.normalized;
}

/**
 * Validate a repository URI
 * 
 * @param uri Repository URI to validate
 * @returns Validation result
 */
export function validateRepositoryURI(uri: string): URIValidationResult {
  try {
    const components = parseRepositoryURI(uri);
    
    switch (components.type) {
      case RepositoryURIType.HTTPS:
        if (!components.host || !components.owner || !components.repo) {
          return {
            valid: false,
            error: "Invalid HTTPS repository URL format. Expected: https://github.com/org/repo.git",
            components
          };
        }
        break;
        
      case RepositoryURIType.SSH:
        if (!components.host || !components.owner || !components.repo) {
          return {
            valid: false,
            error: "Invalid SSH repository URL format. Expected: git@github.com:org/repo.git",
            components
          };
        }
        break;
        
      case RepositoryURIType.LOCAL_FILE:
      case RepositoryURIType.LOCAL_PATH:
        // Validate local path exists
        const path = components.path;
        if (!path || !existsSync(path)) {
          return {
            valid: false,
            error: `Local repository path does not exist: ${path}`,
            components
          };
        }
        break;
        
      case RepositoryURIType.GITHUB_SHORTHAND:
        if (!components.owner || !components.repo) {
          return {
            valid: false,
            error: "Invalid GitHub shorthand format. Expected: org/repo",
            components
          };
        }
        break;
    }
    
    return {
      valid: true,
      components
    };
  } catch (error) {
    return {
      valid: false,
      error: `Invalid repository URI: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/**
 * Convert a repository URI to a specific format
 * 
 * @param uri Repository URI to convert
 * @param targetType Target URI type
 * @returns Converted URI or null if conversion is not possible
 */
export function convertRepositoryURI(uri: string, targetType: RepositoryURIType): string | null {
  const components = parseRepositoryURI(uri);
  
  switch (targetType) {
    case RepositoryURIType.HTTPS:
      // Can only convert if we have owner and repo
      if (components.owner && components.repo) {
        return `https://github.com/${components.owner}/${components.repo}.git`;
      }
      return null;
      
    case RepositoryURIType.SSH:
      // Can only convert if we have owner and repo
      if (components.owner && components.repo) {
        return `git@github.com:${components.owner}/${components.repo}.git`;
      }
      return null;
      
    case RepositoryURIType.GITHUB_SHORTHAND:
      // Can only convert if we have owner and repo
      if (components.owner && components.repo) {
        return `${components.owner}/${components.repo}`;
      }
      return null;
      
    case RepositoryURIType.LOCAL_FILE:
      // Can only convert local paths
      if (components.path) {
        return `file://${components.path}`;
      }
      return null;
      
    case RepositoryURIType.LOCAL_PATH:
      // Can only convert file:// URIs
      if (components.type === RepositoryURIType.LOCAL_FILE && components.path) {
        return components.path;
      }
      return null;
      
    default:
      return null;
  }
}

/**
 * Check if a repository URI refers to a local repository
 * 
 * @param uri Repository URI to check
 * @returns True if the URI represents a local repository
 */
export function isLocalRepositoryURI(uri: string): boolean {
  const components = parseRepositoryURI(uri);
  return components.type === RepositoryURIType.LOCAL_PATH || 
         components.type === RepositoryURIType.LOCAL_FILE;
}

/**
 * Extract repository name from a URI
 * 
 * @param uri Repository URI
 * @returns Repository name
 */
export function getRepositoryName(uri: string): string {
  const components = parseRepositoryURI(uri);
  
  if (components.repo) {
    return components.repo;
  }
  
  if (components.path) {
    return basename(components.path);
  }
  
  return "unknown";
}

/**
 * Convert a GitHub shorthand notation to a full URI
 * 
 * @param shorthand GitHub shorthand (org/repo)
 * @param format Target format (https or ssh)
 * @returns Full repository URI
 */
export function expandGitHubShorthand(
  shorthand: string, 
  format: "https" | "ssh" = "https"
): string | null {
  if (!shorthand.includes("/") || shorthand.startsWith("/")) {
    return null;
  }
  
  const parts = shorthand.split("/");
  if (parts.length !== 2) {
    return null;
  }
  
  const [owner, repo] = parts;
  
  if (format === "https") {
    return `https://github.com/${owner}/${repo}.git`;
  } else {
    return `git@github.com:${owner}/${repo}.git`;
  }
}

/**
 * @deprecated Use normalizeRepositoryURI instead
 * Maintain backward compatibility with existing code
 */
export function normalizeRepoName(repoUrl: string): string {
  return normalizeRepositoryURI(repoUrl);
} 
