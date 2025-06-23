import { describe, it, expect, mock } from "bun:test";
import { Command } from "commander";
import { spyOn } from "../../../../utils/test-utils/compatibility/mock-function";
import {
  addRepoOptions,
  addOutputOptions,
  addTaskOptions,
  addBackendOptions,
  normalizeRepoOptions,
  normalizeOutputOptions,
  normalizeTaskOptions,
  normalizeTaskParams,
  normalizeSessionParams,
} from "../shared-options";
import type { RepoOptions, OutputOptions, TaskOptions } from "../shared-options";
const TEST_VALUE = 123;

// Mock normalizeTaskId from domain to avoid external dependencies
mock.module("../../../../domain/tasks", () => ({
  normalizeTaskId: mock((_taskId: unknown) => {
    if (!taskId) return null;
    // Mock implementation that adds # prefix if not present (like the real function)
    if (taskId.startsWith("#")) {
      return taskId;
    }
    return `#${taskId}`;
  }),
}));

describe("Shared CLI Options", () => {
  describe("Option Application Functions", () => {
    it("should add repository options to a command", () => {
      const _command = new Command();
      const spy = spyOn(_command, "option");

      addRepoOptions(_command);

      // Verify the correct options were added
      expect(spy.mock.calls.length).toBe(3);
      expect(spy.mock.calls[0]).toEqual(["--session <session>", "Name of the session to use"]);
      expect(spy.mock.calls[1]).toEqual([
        "--repo <repositoryUri>",
        "Repository URI (local path, URL, or shorthand)",
      ]);
      expect(spy.mock.calls[2]).toEqual([
        "--upstream-repo <upstreamRepoUri>",
        "Upstream repository URI",
      ]);
    });

    it("should add output format options to a command", () => {
      const _command = new Command();
      const spy = spyOn(_command, "option");

      addOutputOptions(_command);

      // Verify the correct options were added
      expect(spy.mock.calls.length).toBe(2);
      expect(spy.mock.calls[0]).toEqual(["--json", "Format output as JSON"]);
      expect(spy.mock.calls[1]).toEqual(["--debug", "Show debug information"]);
    });

    it("should add task identification options to a command", () => {
      const _command = new Command();
      const spy = spyOn(_command, "option");

      addTaskOptions(_command);

      // Verify the correct options were added
      expect(spy.mock.calls.length).toBe(1);
      expect(spy.mock.calls[0]).toEqual([
        "--task <taskId>",
        "ID of the task (with or without # _prefix)",
      ]);
    });

    it("should add backend options to a command", () => {
      const _command = new Command();
      const spy = spyOn(_command, "option");

      addBackendOptions(_command);

      // Verify the correct options were added
      expect(spy.mock.calls.length).toBe(1);
      expect(spy.mock.calls[0]).toEqual(["-b, --backend <backend>", "Type of backend to use"]);
    });
  });

  describe("Normalization Functions", () => {
    it("should normalize repository options", () => {
      const _options: RepoOptions = {
        session: "test-session",
        repo: "test-repo",
        "upstream-repo": "test-upstream",
      };

      const normalized = normalizeRepoOptions(_options);

      expect(normalized).toEqual({
        _session: "test-session",
        repo: "test-repo",
        workspace: "test-upstream",
      });
    });

    it("should normalize output format options", () => {
      const _options: OutputOptions = {
        json: true,
        debug: true,
      };

      const normalized = normalizeOutputOptions(_options);

      expect(normalized).toEqual({
        json: true,
        debug: true,
      });
    });

    it("should normalize task options and handle normalizing the task ID", () => {
      const _options: TaskOptions = {
        task: "#TEST_VALUE",
      };

      const normalized = normalizeTaskOptions(_options);

      expect(normalized).toEqual({
        task: "#TEST_VALUE",
      });
    });

    it("should normalize task params", () => {
      const _options = {
        session: "test-session",
        repo: "test-repo",
        "upstream-repo": "test-upstream",
        json: true,
        debug: true,
        backend: "markdown",
      };

      const normalized = normalizeTaskParams(_options);

      expect(normalized).toEqual({
        _session: "test-session",
        repo: "test-repo",
        workspace: "test-upstream",
        json: true,
        debug: true,
        backend: "markdown",
      });
    });

    it("should normalize session params", () => {
      const _options = {
        session: "test-session",
        repo: "test-repo",
        "upstream-repo": "test-upstream",
        json: true,
        debug: true,
        task: "#TEST_VALUE",
      };

      const normalized = normalizeSessionParams(_options);

      expect(normalized).toEqual({
        _session: "test-session",
        repo: "test-repo",
        workspace: "test-upstream",
        json: true,
        debug: true,
        task: "#TEST_VALUE",
      });
    });
  });
});
