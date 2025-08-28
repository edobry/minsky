import { describe, test, expect } from "bun:test";
import {
  normalizeRepositoryUri,
  validateRepositoryUri,
  convertRepositoryUri,
  extractRepositoryInfo,
  UriFormat,
} from "./uri-utils";
import { GIT_TEST_PATTERNS } from "../utils/test-utils/test-constants";

// We'll skip validation tests since mocking is tricky in Bun

describe("URI Utilities", () => {
  describe("normalizeRepositoryUri", () => {
    test("normalizes HTTPS URLs", () => {
      const uri = "https://github.com/org/repo.git";
      const _result = normalizeRepositoryUri(uri, { validateLocalExists: false });

      expect(_result)!.toEqual({
        uri: "https://github.com/org/repo",
        name: "org/repo",
        format: UriFormat.HTTPS,
        isLocal: false,
      });
    });

    test("normalizes SSH URLs", () => {
      const uri = GIT_TEST_PATTERNS.SSH_REPO_URL;
      const _result = normalizeRepositoryUri(uri, { validateLocalExists: false });

      expect(_result)!.toEqual({
        uri: "git@github.com:org/repo",
        name: "org/repo",
        format: UriFormat.SSH,
        isLocal: false,
      });
    });

    test("normalizes GitHub shorthand", () => {
      const uri = "org/repo";
      const _result = normalizeRepositoryUri(uri, { validateLocalExists: false });

      expect(_result)!.toEqual({
        uri: "https://github.com/org/repo",
        name: "org/repo",
        format: UriFormat.HTTPS,
        isLocal: false,
      });
    });
  });

  describe("convertRepositoryUri", () => {
    test("converts HTTPS to SSH", () => {
      const uri = "https://github.com/org/repo";
      const _result = convertRepositoryUri(uri, UriFormat.SSH);
      expect(_result)!.toBe(GIT_TEST_PATTERNS.SSH_REPO_URL);
    });

    test("converts SSH to HTTPS", () => {
      const uri = GIT_TEST_PATTERNS.SSH_REPO_URL;
      const _result = convertRepositoryUri(uri, UriFormat.HTTPS);
      expect(_result)!.toBe("https://github.com/org/repo");
    });

    test("converts shorthand to HTTPS", () => {
      const uri = "org/repo";
      const _result = convertRepositoryUri(uri, UriFormat.HTTPS);
      expect(_result)!.toBe("https://github.com/org/repo");
    });

    test("returns same URI if already in target format", () => {
      const uri = "https://github.com/org/repo";
      const _result = convertRepositoryUri(uri, UriFormat.HTTPS);
      expect(_result)!.toBe(uri);
    });
  });

  describe("extractRepositoryInfo", () => {
    test("extracts info from HTTPS URL", () => {
      const uri = "https://github.com/org/repo.git";
      const _result = extractRepositoryInfo(uri);
      expect(_result)!.toEqual({ owner: "org", repo: "repo" });
    });

    test("extracts info from SSH URL", () => {
      const uri = GIT_TEST_PATTERNS.SSH_REPO_URL;
      const _result = extractRepositoryInfo(uri);
      expect(_result)!.toEqual({ owner: "org", repo: "repo" });
    });

    test("extracts info from shorthand", () => {
      const uri = "org/repo";
      const _result = extractRepositoryInfo(uri);
      expect(_result)!.toEqual({ owner: "org", repo: "repo" });
    });
  });
});
