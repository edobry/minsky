import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { existsSync, mkdirSync } from "fs";
import {
  parseRepositoryURI,
  normalizeRepositoryURI,
  validateRepositoryURI,
  convertRepositoryURI,
  isLocalRepositoryURI,
  getRepositoryName,
  expandGitHubShorthand,
  RepositoryURIType,
  normalizeRepoName
} from "../repository-uri.js";

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
    
    test("parses local file URIs", () => {
      const uri = `file://${testRepoPath}`;
      const result = parseRepositoryURI(uri);
      
      expect(result.type).toBe(RepositoryURIType.LOCAL_FILE);
      expect(result.scheme).toBe("file");
      expect(result.path).toBe(testRepoPath);
      expect(result.normalized).toBe(`local/test-repo`);
      expect(result.original).toBe(uri);
    });
    
    test("parses local paths", () => {
      const uri = testRepoPath;
      const result = parseRepositoryURI(uri);
      
      expect(result.type).toBe(RepositoryURIType.LOCAL_PATH);
      expect(result.path).toBe(testRepoPath);
      expect(result.normalized).toBe(`local/test-repo`);
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
    
    test("handles URLs with .git suffix", () => {
      const uri = "https://github.com/org/repo.git";
      const result = parseRepositoryURI(uri);
      
      expect(result.repo).toBe("repo");
      expect(result.normalized).toBe("org/repo");
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
    
    test("normalizes local file URIs", () => {
      expect(normalizeRepositoryURI(`file://${testRepoPath}`)).toBe("local/test-repo");
    });
    
    test("normalizes local paths", () => {
      expect(normalizeRepositoryURI(testRepoPath)).toBe("local/test-repo");
    });
    
    test("preserves GitHub shorthand", () => {
      expect(normalizeRepositoryURI("org/repo")).toBe("org/repo");
    });
  });
  
  describe("validateRepositoryURI", () => {
    test("validates HTTPS URLs", () => {
      const result = validateRepositoryURI("https://github.com/org/repo.git");
      expect(result.valid).toBe(true);
      expect(result.components?.type).toBe(RepositoryURIType.HTTPS);
    });
    
    test("validates SSH URLs", () => {
      const result = validateRepositoryURI("git@github.com:org/repo.git");
      expect(result.valid).toBe(true);
      expect(result.components?.type).toBe(RepositoryURIType.SSH);
    });
    
    test("validates local file URIs for existing paths", () => {
      const result = validateRepositoryURI(`file://${testRepoPath}`);
      expect(result.valid).toBe(true);
      expect(result.components?.type).toBe(RepositoryURIType.LOCAL_FILE);
    });
    
    test("validates local paths", () => {
      const result = validateRepositoryURI(testRepoPath);
      expect(result.valid).toBe(true);
      expect(result.components?.type).toBe(RepositoryURIType.LOCAL_PATH);
    });
    
    test("validates GitHub shorthand", () => {
      const result = validateRepositoryURI("org/repo");
      expect(result.valid).toBe(true);
      expect(result.components?.type).toBe(RepositoryURIType.GITHUB_SHORTHAND);
    });
    
    test("returns invalid for non-existent local paths", () => {
      const result = validateRepositoryURI("/this/path/does/not/exist");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("does not exist");
    });
    
    test("returns invalid for malformed URLs", () => {
      const result = validateRepositoryURI("https://malformed[url");
      expect(result.valid).toBe(false);
    });
    
    test("returns invalid for malformed GitHub shorthand", () => {
      const result = validateRepositoryURI("org/repo/extra");
      expect(result.valid).toBe(false);
    });
  });
  
  describe("convertRepositoryURI", () => {
    test("converts from GitHub shorthand to HTTPS URL", () => {
      const result = convertRepositoryURI("org/repo", RepositoryURIType.HTTPS);
      expect(result).toBe("https://github.com/org/repo.git");
    });
    
    test("converts from GitHub shorthand to SSH URL", () => {
      const result = convertRepositoryURI("org/repo", RepositoryURIType.SSH);
      expect(result).toBe("git@github.com:org/repo.git");
    });
    
    test("converts from HTTPS URL to SSH URL", () => {
      const result = convertRepositoryURI("https://github.com/org/repo.git", RepositoryURIType.SSH);
      expect(result).toBe("git@github.com:org/repo.git");
    });
    
    test("converts from SSH URL to HTTPS URL", () => {
      const result = convertRepositoryURI("git@github.com:org/repo.git", RepositoryURIType.HTTPS);
      expect(result).toBe("https://github.com/org/repo.git");
    });
    
    test("converts local path to file URI", () => {
      const result = convertRepositoryURI(testRepoPath, RepositoryURIType.LOCAL_FILE);
      expect(result).toBe(`file://${testRepoPath}`);
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
    
    test("returns true for file:// URIs", () => {
      expect(isLocalRepositoryURI(`file://${testRepoPath}`)).toBe(true);
    });
    
    test("returns false for HTTPS URLs", () => {
      expect(isLocalRepositoryURI("https://github.com/org/repo.git")).toBe(false);
    });
    
    test("returns false for SSH URLs", () => {
      expect(isLocalRepositoryURI("git@github.com:org/repo.git")).toBe(false);
    });
    
    test("returns false for GitHub shorthand", () => {
      expect(isLocalRepositoryURI("org/repo")).toBe(false);
    });
  });
  
  describe("getRepositoryName", () => {
    test("extracts name from HTTPS URL", () => {
      expect(getRepositoryName("https://github.com/org/repo.git")).toBe("repo");
    });
    
    test("extracts name from SSH URL", () => {
      expect(getRepositoryName("git@github.com:org/repo.git")).toBe("repo");
    });
    
    test("extracts name from local path", () => {
      expect(getRepositoryName(testRepoPath)).toBe("test-repo");
    });
    
    test("extracts name from GitHub shorthand", () => {
      expect(getRepositoryName("org/repo")).toBe("repo");
    });
  });
  
  describe("expandGitHubShorthand", () => {
    test("expands to HTTPS URL by default", () => {
      expect(expandGitHubShorthand("org/repo")).toBe("https://github.com/org/repo.git");
    });
    
    test("expands to SSH URL when specified", () => {
      expect(expandGitHubShorthand("org/repo", "ssh")).toBe("git@github.com:org/repo.git");
    });
    
    test("returns null for invalid shorthand", () => {
      expect(expandGitHubShorthand("not/a/valid/shorthand")).toBeNull();
    });
  });
  
  describe("backward compatibility", () => {
    test("normalizeRepoName uses normalizeRepositoryURI", () => {
      // Test that the deprecated function works the same as the new one
      const testUrl = "https://github.com/org/repo.git";
      expect(normalizeRepoName(testUrl)).toBe(normalizeRepositoryURI(testUrl));
    });
  });
}); 
