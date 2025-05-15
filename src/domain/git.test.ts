/**
 * Tests for the git service
 */
import { describe, test, expect, jest } from "bun:test";
import { GitService } from "./git";
import { existsSync } from "fs";

describe("GitService", () => {
  test("should be able to create an instance", () => {
    const gitService = new GitService();
    expect(gitService instanceof GitService).toBe(true);
  });
  
  test("getStatus should return a promise", () => {
    const gitService = new GitService();
    const statusPromise = gitService.getStatus("/mock/path");
    expect(statusPromise instanceof Promise).toBe(true);
  });
});
