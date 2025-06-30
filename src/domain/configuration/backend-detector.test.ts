/**
 * Tests for backend detection logic
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { DefaultBackendDetector } from "./backend-detector";
import { DetectionRule } from "./types";
import { join } from "path";
import { promises as fs } from "fs";
import { tmpdir } from "os";

describe("DefaultBackendDetector", () => {
  let detector: DefaultBackendDetector;
  let tempDir: string;

  beforeEach(async () => {
    detector = new DefaultBackendDetector();
    tempDir = join(tmpdir(), `backend-detector-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("detectBackend", () => {
    it("should detect markdown backend when process/tasks.md exists", async () => {
      // Create process/tasks.md
      const processDir = join(tempDir, "process");
      await fs.mkdir(processDir, { recursive: true });
      await fs.writeFile(join(processDir, "tasks.md"), "# Tasks\n");

      const rules: DetectionRule[] = [
        { condition: "tasks_md_exists", backend: "markdown" },
        { condition: "json_file_exists", backend: "json-file" },
        { condition: "always", backend: "json-file" },
      ];

      const _result = await detector.detectBackend(tempDir, rules);
      expect(_result).toBe("markdown");
    });

    it("should detect json-file backend when .minsky/tasks.json exists", async () => {
      // Create .minsky/tasks.json
      const minskyhDir = join(tempDir, ".minsky");
      await fs.mkdir(minskyhDir, { recursive: true });
      await fs.writeFile(join(minskyhDir, "tasks.json"), "[]");

      const rules: DetectionRule[] = [
        { condition: "tasks_md_exists", backend: "markdown" },
        { condition: "json_file_exists", backend: "json-file" },
        { condition: "always", backend: "json-file" },
      ];

      const _result = await detector.detectBackend(tempDir, rules);
      expect(_result).toBe("json-file");
    });

    it("should prioritize markdown over json-file when both exist", async () => {
      // Create both files
      const processDir = join(tempDir, "process");
      await fs.mkdir(processDir, { recursive: true });
      await fs.writeFile(join(processDir, "tasks.md"), "# Tasks\n");

      const minskyhDir = join(tempDir, ".minsky");
      await fs.mkdir(minskyhDir, { recursive: true });
      await fs.writeFile(join(minskyhDir, "tasks.json"), "[]");

      const rules: DetectionRule[] = [
        { condition: "tasks_md_exists", backend: "markdown" },
        { condition: "json_file_exists", backend: "json-file" },
        { condition: "always", backend: "json-file" },
      ];

      const _result = await detector.detectBackend(tempDir, rules);
      expect(_result).toBe("markdown");
    });

    it("should fallback to json-file when no specific files exist", async () => {
      const rules: DetectionRule[] = [
        { condition: "tasks_md_exists", backend: "markdown" },
        { condition: "json_file_exists", backend: "json-file" },
        { condition: "always", backend: "json-file" },
      ];

      const _result = await detector.detectBackend(tempDir, rules);
      expect(_result).toBe("json-file");
    });

    it("should respect custom rule order", async () => {
      // Create process/tasks.md
      const processDir = join(tempDir, "process");
      await fs.mkdir(processDir, { recursive: true });
      await fs.writeFile(join(processDir, "tasks.md"), "# Tasks\n");

      // Custom rules with different priority
      const rules: DetectionRule[] = [
        { condition: "json_file_exists", backend: "json-file" },
        { condition: "tasks_md_exists", backend: "markdown" },
        { condition: "always", backend: "json-file" },
      ];

      const _result = await detector.detectBackend(tempDir, rules);
      expect(_result).toBe("markdown"); // Still finds markdown even though json rule comes first
    });
  });

  describe("tasksMdExists", () => {
    it("should return true when process/tasks.md exists", async () => {
      const processDir = join(tempDir, "process");
      await fs.mkdir(processDir, { recursive: true });
      await fs.writeFile(join(processDir, "tasks.md"), "# Tasks\n");

      const _result = await detector.tasksMdExists(tempDir);
      expect(_result).toBe(true);
    });

    it("should return false when process/tasks.md does not exist", async () => {
      const _result = await detector.tasksMdExists(tempDir);
      expect(_result).toBe(false);
    });

    it("should return false when process directory does not exist", async () => {
      const _result = await detector.tasksMdExists(tempDir);
      expect(_result).toBe(false);
    });
  });

  describe("jsonFileExists", () => {
    it("should return true when .minsky/tasks.json exists", async () => {
      const minskyhDir = join(tempDir, ".minsky");
      await fs.mkdir(minskyhDir, { recursive: true });
      await fs.writeFile(join(minskyhDir, "tasks.json"), "[]");

      const _result = await detector.jsonFileExists(tempDir);
      expect(_result).toBe(true);
    });

    it("should return false when .minsky/tasks.json does not exist", async () => {
      const _result = await detector.jsonFileExists(tempDir);
      expect(_result).toBe(false);
    });

    it("should return false when .minsky directory does not exist", async () => {
      const _result = await detector.jsonFileExists(tempDir);
      expect(_result).toBe(false);
    });
  });

  describe("githubRemoteExists", () => {
    it("should return false (disabled for auto-detection)", async () => {
      // Even if we're in a git repo with GitHub remote, this should return false
      // because GitHub Issues detection is now disabled for auto-detection
      const _result = await detector.githubRemoteExists(tempDir);
      expect(_result).toBe(false);
    });
  });

  describe("integration with default rules", () => {
    it("should match the behavior described in the original issue", async () => {
      // Simulate the minsky repository structure
      const processDir = join(tempDir, "process");
      await fs.mkdir(processDir, { recursive: true });
      await fs.writeFile(join(processDir, "tasks.md"), "# Tasks\n- #001: Some task");

      // Use the default detection rules from types.ts
      const rules: DetectionRule[] = [
        { condition: "tasks_md_exists", backend: "markdown" },
        { condition: "json_file_exists", backend: "json-file" },
        { condition: "always", backend: "json-file" },
      ];

      const _result = await detector.detectBackend(tempDir, rules);

      // Should detect markdown backend, not github-issues
      expect(_result).toBe("markdown");
    });
  });
});
