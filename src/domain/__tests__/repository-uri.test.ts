/**
 * Repository URI Tests
 * @migrated Already using native Bun patterns
 * @refactored Uses project utilities and proper TypeScript imports
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { existsSync, mkdirSync } from "fs";
import { setupTestMocks } from "../../utils/test-utils/mocking.ts";
import { UriFormat } from "../uri-utils.ts";
import {
  parseRepositoryURI,
  normalizeRepositoryURI,
  validateRepositoryURI,
  convertRepositoryURI,
  isLocalRepositoryURI,
  getRepositoryName,
  expandGitHubShorthand,
  RepositoryURIType,
  detectRepositoryURI
} from "../repository-uri.ts";

// Set up automatic mock cleanup
setupTestMocks();

/**
 * Create a unique temporary directory for testing
 */
async function createTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "repo-uri-test-"));
}

/**
 * Create a test repository directory
 */
function createTestRepo(baseDir: string, name: string): string {
  const repoPath = join(baseDir, name);
  const gitDir = join(repoPath, ".git");
  
  mkdirSync(gitDir, { recursive: true });
  return repoPath;
}

describe("Repository URI Utilities", () => {
  let tempDir: string;
  let testRepoPath: string;
  
  beforeEach(async () => {
    tempDir = await createTempDir();
    testRepoPath = createTestRepo(tempDir, "test-repo");
  });
  
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  
  describe("parseRepositoryURI", () => {
    test("parses HTTPS URLs", () => {
      const uri = "https://github.com/org/repo.git";
      const result = parseRepositoryURI(uri);
      
      expect(result.type).toBe(RepositoryURIType.HTTPS);
      expect(result.scheme).toBe("https");
      expect(result.host).toBe("github.com");
      expect(result.owner).toBe("org");
      expect(result.repo).toBe("repo");
      expect(result.normalized).toBe("org/repo");
      expect(result.original).toBe(uri);
    });
    
    test("parses SSH URLs", () => {
      const uri = "git@github.com:org/repo.git";
      const result = parseRepositoryURI(uri);
      
      expect(result.type).toBe(RepositoryURIType.SSH);
      expect(result.scheme).toBe("ssh");
      expect(result.host).toBe("github.com");
      expect(result.owner).toBe("org");
      expect(result.repo).toBe("repo");
      expect(result.normalized).toBe("org/repo");
      expect(result.original).toBe(uri);
    });
    
    test("parses GitHub shorthand", () => {
      const uri = "org/repo";
      const result = parseRepositoryURI(uri);
      
      expect(result.type).toBe(RepositoryURIType.GITHUB_SHORTHAND);
      expect(result.owner).toBe("org");
      expect(result.repo).toBe("repo");
      expect(result.normalized).toBe("org/repo");
      expect(result.original).toBe(uri);
    });
    
    test("handles invalid URLs gracefully", () => {
      const uri = "https://invalid]url";
      const result = parseRepositoryURI(uri);
      
      // Should fall back to treating it as a local path
      expect(result.type).toBe(RepositoryURIType.LOCAL_PATH);
      expect(result.normalized).toContain("local/");
    });
  });
  
  describe("normalizeRepositoryURI", () => {
    test("normalizes HTTPS URLs", () => {
      expect(normalizeRepositoryURI("https://github.com/org/repo.git")).toBe("org/repo");
    });
    
    test("normalizes SSH URLs", () => {
      expect(normalizeRepositoryURI("git@github.com:org/repo.git")).toBe("org/repo");
    });
    
    test("preserves GitHub shorthand", () => {
      expect(normalizeRepositoryURI("org/repo")).toBe("org/repo");
    });
  });
  
  describe("validateRepositoryURI", () => {
    test("returns true for valid HTTPS URLs", () => {
      const result = validateRepositoryURI("https://github.com/org/repo.git");
      expect(result.valid).toBe(true);
    });
    
    test("returns false for invalid URIs", () => {
      const result = validateRepositoryURI("/this/path/does/not/exist");
      expect(result.valid).toBe(false);
    });
  });
  
  describe("convertRepositoryURI", () => {
    test("converts from GitHub shorthand to HTTPS URL", () => {
      const result = convertRepositoryURI("org/repo", RepositoryURIType.HTTPS);
      expect(result).toBe("https://github.com/org/repo");
    });
    
    test("converts from GitHub shorthand to SSH URL", () => {
      const result = convertRepositoryURI("org/repo", RepositoryURIType.SSH);
      expect(result).toBe("git@github.com:org/repo.git");
    });
    
    test("converts from HTTPS URL to SSH URL", () => {
      const result = convertRepositoryURI("https://github.com/org/repo.git", RepositoryURIType.SSH);
      expect(result).toBe("git@github.com:org/repo.git");
    });
    
    test("returns null for incompatible conversions", () => {
      // Can't convert local path to GitHub shorthand
      const result = convertRepositoryURI(testRepoPath, RepositoryURIType.GITHUB_SHORTHAND);
      expect(result).toBeNull();
    });
  });
  
  describe("isLocalRepositoryURI", () => {
    test("returns true for local paths", () => {
      expect(isLocalRepositoryURI(testRepoPath)).toBe(true);
    });
    
    test("returns false for HTTPS URLs", () => {
      expect(isLocalRepositoryURI("https://github.com/org/repo.git")).toBe(false);
    });
  });
  
  describe("getRepositoryName", () => {
    test("extracts name from HTTPS URL", () => {
      expect(getRepositoryName("https://github.com/org/repo.git")).toBe("repo");
    });
    
    test("extracts name from SSH URL", () => {
      expect(getRepositoryName("git@github.com:org/repo.git")).toBe("repo");
    });
    
    test("extracts name from GitHub shorthand", () => {
      expect(getRepositoryName("org/repo")).toBe("repo");
    });
  });
  
  describe("expandGitHubShorthand", () => {
    test("expands to HTTPS URL by default", () => {
      expect(expandGitHubShorthand("org/repo")).toBe("https://github.com/org/repo");
    });
    
    test("expands to SSH URL when specified", () => {
      expect(expandGitHubShorthand("org/repo", "ssh")).toBe("git@github.com:org/repo.git");
    });
    
    test("returns null for invalid shorthand", () => {
      expect(expandGitHubShorthand("not/a/valid/shorthand")).toBeNull();
    });
  });
}); 
