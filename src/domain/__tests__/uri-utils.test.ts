import { describe, test, expect, beforeEach, mock } from "bun:test";
import {
  normalizeRepositoryUri,
  validateRepositoryUri,
  convertRepositoryUri,
  extractRepositoryInfo,
  UriFormat
} from "../uri-utils.js";
import { ValidationError } from "../../errors/index.js";
import * as fs from "fs";

// Mock fs.existsSync to avoid filesystem checks during testing
mock.module("fs", () => {
  return {
    ...fs,
    existsSync: () => true
  };
});

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
    
    test("normalizes file:// URIs", () => {
      const uri = "file:///path/to/repo";
      const result = normalizeRepositoryUri(uri, { validateLocalExists: false });
      
      expect(result).toEqual({
        uri: "file:///path/to/repo",
        name: "local/repo",
        format: UriFormat.FILE,
        isLocal: true
      });
    });
    
    test("normalizes plain filesystem paths", () => {
      const uri = "/path/to/repo";
      const result = normalizeRepositoryUri(uri, { validateLocalExists: false });
      
      expect(result).toEqual({
        uri: "file:///path/to/repo",
        name: "local/repo",
        format: UriFormat.FILE,
        isLocal: true
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
    
    test("handles Windows-style paths", () => {
      const uri = "C:\\path\\to\\repo";
      const result = normalizeRepositoryUri(uri, { validateLocalExists: false });
      
      expect(result).toEqual({
        uri: "file://C:\\path\\to\\repo",
        name: "local/repo",
        format: UriFormat.FILE,
        isLocal: true
      });
    });
    
    test("rejects empty URIs", () => {
      let caught = false;
      try {
        normalizeRepositoryUri("");
      } catch (error) {
        caught = true;
        expect(error instanceof ValidationError).toBe(true);
        expect((error as ValidationError).message).toContain("cannot be empty");
      }
      expect(caught).toBe(true);
    });
    
    test("rejects invalid URIs", () => {
      let caught = false;
      try {
        normalizeRepositoryUri("not/a/valid/uri/format");
      } catch (error) {
        caught = true;
        expect(error instanceof ValidationError).toBe(true);
        expect((error as ValidationError).message).toContain("Unrecognized");
      }
      expect(caught).toBe(true);
    });
  });
  
  describe("validateRepositoryUri", () => {
    test("validates valid URIs", () => {
      const uri = "https://github.com/org/repo.git";
      expect(validateRepositoryUri(uri, { validateLocalExists: false })).toBe(true);
    });
    
    test("rejects invalid URIs", () => {
      let caught = false;
      try {
        validateRepositoryUri("");
      } catch (error) {
        caught = true;
        expect(error instanceof ValidationError).toBe(true);
      }
      expect(caught).toBe(true);
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
    
    test("converts file:// to plain path", () => {
      const uri = "file:///path/to/repo";
      const result = convertRepositoryUri(uri, UriFormat.PATH);
      expect(result).toBe("/path/to/repo");
    });
    
    test("converts plain path to file://", () => {
      const uri = "/path/to/repo";
      const result = convertRepositoryUri(uri, UriFormat.FILE);
      expect(result).toBe("file:///path/to/repo");
    });
    
    test("returns same URI if already in target format", () => {
      const uri = "https://github.com/org/repo";
      const result = convertRepositoryUri(uri, UriFormat.HTTPS);
      expect(result).toBe(uri);
    });
    
    test("throws error for unsupported conversions", () => {
      const uri = "/path/to/repo";
      let caught = false;
      try {
        convertRepositoryUri(uri, UriFormat.SSH);
      } catch (error) {
        caught = true;
        expect(error instanceof ValidationError).toBe(true);
        expect((error as ValidationError).message).toContain("Cannot convert local repository");
      }
      expect(caught).toBe(true);
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
    
    test("extracts info from local repository", () => {
      const uri = "/path/to/repo";
      const result = extractRepositoryInfo(uri);
      expect(result).toEqual({ owner: "local", repo: "repo" });
    });
    
    test("throws error if unable to extract info", () => {
      let caught = false;
      try {
        // Mock normalizeRepositoryUri to return an invalid name format
        const originalNormalizeRepositoryUri = normalizeRepositoryUri;
        // @ts-expect-error: Mocking for tests
        normalizeRepositoryUri = () => ({ name: "invalid-format" });
        
        extractRepositoryInfo("some-uri");
      } catch (error) {
        caught = true;
        expect(error instanceof ValidationError).toBe(true);
      } finally {
        // Restore the original function
        // @ts-expect-error: Restoring mock
        normalizeRepositoryUri = originalNormalizeRepositoryUri;
      }
      expect(caught).toBe(true);
    });
  });
}); 
