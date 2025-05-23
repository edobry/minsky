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
import type {
  RepoOptions,
  OutputOptions,
  TaskOptions,
  BackendOptions,
} from "../shared-options";

// Mock normalizeTaskId from domain to avoid external dependencies
mock.module("../../../../domain/tasks", () => ({
  normalizeTaskId: mock((taskId: string) => {
    if (!taskId) return null;
    // Simple mock implementation that handles format conversion
    if (taskId.startsWith("#")) {
      return taskId.substring(1);
    }
    return taskId;
  }),
}));

describe("Shared CLI Options", () => {
  describe("Option Application Functions", () => {
    it("DEBUG: should show what spy captures for repo options", () => {
      const command = new Command();
      const spy = spyOn(command, "option");

      addRepoOptions(command);

      console.log("Spy call count:", spy.mock.calls.length);
      spy.mock.calls.forEach((call, index) => {
        console.log(`Call ${index}:`, call);
      });
    });

    it("should add repository options to a command", () => {
      const command = new Command();
      const spy = spyOn(command, "option");

      addRepoOptions(command);

      // Verify the correct options were added
      expect(spy.mock.calls.length).toBe(3);
      expect(spy.mock.calls[0]).toEqual(["--session <session>", "Name of the session to use"]);
      expect(spy.mock.calls[1]).toEqual([
        "--repo <repositoryUri>",
        "Repository URI (local path, URL, or shorthand)"
      ]);
      expect(spy.mock.calls[2]).toEqual([
        "--upstream-repo <upstreamRepoUri>",
        "Upstream repository URI"
      ]);
    });

    it("should add output format options to a command", () => {
      const command = new Command();
      const spy = spyOn(command, "option");

      addOutputOptions(command);

      // Verify the correct options were added
      expect(spy.mock.calls.length).toBe(2);
      expect(spy.mock.calls[0]).toEqual(["--json", "Format output as JSON"]);
      expect(spy.mock.calls[1]).toEqual(["--debug", "Show debug information"]);
    });

    it("should add task identification options to a command", () => {
      const command = new Command();
      const spy = spyOn(command, "option");

      addTaskOptions(command);

      // Verify the correct options were added
      expect(spy.mock.calls.length).toBe(1);
      expect(spy.mock.calls[0]).toEqual([
        "--task <taskId>",
        "ID of the task (with or without # prefix)"
      ]);
    });

    it("should add backend options to a command", () => {
      const command = new Command();
      const spy = spyOn(command, "option");

      addBackendOptions(command);

      // Verify the correct options were added
      expect(spy.mock.calls.length).toBe(1);
      expect(spy.mock.calls[0]).toEqual(["-b, --backend <backend>", "Type of backend to use"]);
    });
  });

  describe("Normalization Functions", () => {
    it("should normalize repository options", () => {
      const options: RepoOptions = {
        session: "test-session",
        repo: "test-repo",
        "upstream-repo": "test-upstream",
      };

      const normalized = normalizeRepoOptions(options);

      expect(normalized).toEqual({
        session: "test-session",
        repo: "test-repo",
        workspace: "test-upstream",
      });
    });

    it("should normalize output format options", () => {
      const options: OutputOptions = {
        json: true,
        debug: true,
      };

      const normalized = normalizeOutputOptions(options);

      expect(normalized).toEqual({
        json: true,
        debug: true,
      });
    });

    it("should normalize task options and handle normalizing the task ID", () => {
      const options: TaskOptions = {
        task: "#123",
      };

      const normalized = normalizeTaskOptions(options);

      expect(normalized).toEqual({
        task: "#123",
      });
    });

    it("should normalize task params", () => {
      const options = {
        session: "test-session",
        repo: "test-repo",
        "upstream-repo": "test-upstream",
        json: true,
        debug: true,
        backend: "markdown",
      };

      const normalized = normalizeTaskParams(options);

      expect(normalized).toEqual({
        session: "test-session",
        repo: "test-repo",
        workspace: "test-upstream",
        json: true,
        debug: true,
        backend: "markdown",
      });
    });

    it("should normalize session params", () => {
      const options = {
        session: "test-session",
        repo: "test-repo",
        "upstream-repo": "test-upstream",
        json: true,
        debug: true,
        task: "#123",
      };

      const normalized = normalizeSessionParams(options);

      expect(normalized).toEqual({
        session: "test-session",
        repo: "test-repo",
        workspace: "test-upstream",
        json: true,
        debug: true,
        task: "#123",
      });
    });
  });
});
