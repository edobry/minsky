/**
 * Repository URI utilities for standardized handling of repository references.
 * Builds on the core URI utilities in uri-utils.ts to provide standardized
 * handling for repository URI formats.
 */
import { basename } from "path";
import { 
  normalizeRepositoryUri, 
  validateRepositoryUri, 
  convertRepositoryUri, 
  UriFormat, 
  extractRepositoryInfo,
  detectRepositoryFromCwd
} from "./uri-utils.js";

/**
 * Repository URI types that match the formats in UriFormat
 * but with more descriptive names for repository contexts
 */
export enum RepositoryURIType {
  HTTPS = UriFormat.HTTPS,
  SSH = UriFormat.SSH,
  LOCAL_FILE = UriFormat.FILE,
  LOCAL_PATH = UriFormat.PATH,
  GITHUB_SHORTHAND = UriFormat.SHORTHAND
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
  try {
    // Use the underlying normalization function
    const normalizedInfo = normalizeRepositoryUri(uri, { 
      validateLocalExists: false,
      ensureFullyQualified: false // Don't expand shorthand by default
    });
    
    // Extract components based on format
    let components: Partial<RepositoryURIComponents> = {
      original: uri,
      normalized: normalizedInfo.name
    };
    
    // Set the type based on the format
    switch (normalizedInfo.format) {
      case UriFormat.HTTPS:
        components.type = RepositoryURIType.HTTPS;
        components.scheme = "https";
        break;
      case UriFormat.SSH:
        components.type = RepositoryURIType.SSH;
        components.scheme = "ssh";
        break;
      case UriFormat.FILE:
        components.type = RepositoryURIType.LOCAL_FILE;
        components.scheme = "file";
        break;
      case UriFormat.PATH:
        components.type = RepositoryURIType.LOCAL_PATH;
        break;
      case UriFormat.SHORTHAND:
        components.type = RepositoryURIType.GITHUB_SHORTHAND;
        break;
    }
    
    // For non-local repositories, extract owner and repo
    if (!normalizedInfo.isLocal) {
      const { owner, repo } = extractRepositoryInfo(uri);
      components.owner = owner;
      components.repo = repo;
      
      // For URLs, also extract host
      if (components.type === RepositoryURIType.HTTPS) {
        try {
          const url = new URL(normalizedInfo.uri);
          components.host = url.hostname;
        } catch (error) {
          // Ignore URL parsing errors
        }
      } else if (components.type === RepositoryURIType.SSH) {
        // Extract host from SSH URL
        const match = uri.match(/^[^@]+@([^:]+):/);
        if (match && match[1]) {
          components.host = match[1];
        }
      }
    } else {
      // For local repositories, extract path
      if (components.type === RepositoryURIType.LOCAL_FILE) {
        components.path = normalizedInfo.uri.replace(/^file:\/\//, "");
      } else {
        components.path = normalizedInfo.uri;
      }
    }
    
    return components as RepositoryURIComponents;
  } catch (error) {
    // Fallback for any errors
    return {
      type: RepositoryURIType.LOCAL_PATH,
      path: uri,
      normalized: `local/${basename(uri)}`,
      original: uri
    };
  }
}

/**
 * Normalize a repository URI to a standardized format
 * 
 * @param uri Repository URI to normalize
 * @returns Normalized repository identifier
 */
export function normalizeRepositoryURI(uri: string): string {
  try {
    const result = normalizeRepositoryUri(uri, { validateLocalExists: false });
    return result.name;
  } catch (error) {
    // Fallback to simple basename normalization
    return `local/${basename(uri)}`;
  }
}

/**
 * Validate a repository URI
 * 
 * @param uri Repository URI to validate
 * @returns Validation result
 */
export function validateRepositoryURI(uri: string): URIValidationResult {
  try {
    validateRepositoryUri(uri);
    return {
      valid: true,
      components: parseRepositoryURI(uri)
    };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : String(error)
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
  try {
    // Map our RepositoryURIType to UriFormat
    const targetFormat = targetType as unknown as UriFormat;
    return convertRepositoryUri(uri, targetFormat);
  } catch (error) {
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
  try {
    const normalized = normalizeRepositoryUri(uri, { validateLocalExists: false });
    return normalized.isLocal;
  } catch (error) {
    // If we can't parse it, assume it's a local path
    return true;
  }
}

/**
 * Extract repository name from a URI
 * 
 * @param uri Repository URI
 * @returns Repository name
 */
export function getRepositoryName(uri: string): string {
  try {
    const { repo } = extractRepositoryInfo(uri);
    return repo;
  } catch (error) {
    // Fallback to basename for local paths
    return basename(uri);
  }
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
  try {
    const targetFormat = format === "https" ? UriFormat.HTTPS : UriFormat.SSH;
    return convertRepositoryUri(shorthand, targetFormat);
  } catch (error) {
    return null;
  }
}

/**
 * Detect the repository URI from the current working directory
 * 
 * @param cwd Current working directory (defaults to process.cwd())
 * @returns Repository URI if found, undefined otherwise
 */
export async function detectRepositoryURI(cwd?: string): Promise<string | undefined> {
  return detectRepositoryFromCwd(cwd);
} 
