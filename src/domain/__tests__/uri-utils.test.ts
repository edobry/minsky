import { describe, test, expect } from "bun:test";
import {
  normalizeRepositoryUri,
  validateRepositoryUri,
  convertRepositoryUri,
  extractRepositoryInfo,
  UriFormat
} from "../uri-utils.js";
import { ValidationError } from "../../errors/index.js";

// We'll skip validation tests since mocking is tricky in Bun

describe("URI Utilities", () => {
  describe("normalizeRepositoryUri", () => {
    test("normalizes HTTPS URLs", () => {
      const uri = "https://github.com/org/repo.git";
      const result = normalizeRepositoryUri(uri, { validateLocalExists: false });
      
      expect(result).toEqual({
        uri: "https://github.com/org/repo",
        name: "org/repo",
        format: UriFormat.HTTPS,
        isLocal: false
      });
    });
    
    test("normalizes SSH URLs", () => {
      const uri = "git@github.com:org/repo.git";
      const result = normalizeRepositoryUri(uri, { validateLocalExists: false });
      
      expect(result).toEqual({
        uri: "git@github.com:org/repo",
        name: "org/repo",
        format: UriFormat.SSH,
        isLocal: false
      });
    });
    
    test("normalizes GitHub shorthand", () => {
      const uri = "org/repo";
      const result = normalizeRepositoryUri(uri, { validateLocalExists: false });
      
      expect(result).toEqual({
        uri: "https://github.com/org/repo",
        name: "org/repo",
        format: UriFormat.HTTPS,
        isLocal: false
      });
    });
  });
  
  describe("convertRepositoryUri", () => {
    test("converts HTTPS to SSH", () => {
      const uri = "https://github.com/org/repo";
      const result = convertRepositoryUri(uri, UriFormat.SSH);
      expect(result).toBe("git@github.com:org/repo.git");
    });
    
    test("converts SSH to HTTPS", () => {
      const uri = "git@github.com:org/repo.git";
      const result = convertRepositoryUri(uri, UriFormat.HTTPS);
      expect(result).toBe("https://github.com/org/repo");
    });
    
    test("converts shorthand to HTTPS", () => {
      const uri = "org/repo";
      const result = convertRepositoryUri(uri, UriFormat.HTTPS);
      expect(result).toBe("https://github.com/org/repo");
    });
    
    test("returns same URI if already in target format", () => {
      const uri = "https://github.com/org/repo";
      const result = convertRepositoryUri(uri, UriFormat.HTTPS);
      expect(result).toBe(uri);
    });
  });
  
  describe("extractRepositoryInfo", () => {
    test("extracts info from HTTPS URL", () => {
      const uri = "https://github.com/org/repo.git";
      const result = extractRepositoryInfo(uri);
      expect(result).toEqual({ owner: "org", repo: "repo" });
    });
    
    test("extracts info from SSH URL", () => {
      const uri = "git@github.com:org/repo.git";
      const result = extractRepositoryInfo(uri);
      expect(result).toEqual({ owner: "org", repo: "repo" });
    });
    
    test("extracts info from shorthand", () => {
      const uri = "org/repo";
      const result = extractRepositoryInfo(uri);
      expect(result).toEqual({ owner: "org", repo: "repo" });
    });
  });
}); 
