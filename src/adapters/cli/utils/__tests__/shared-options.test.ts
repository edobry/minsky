import { describe, it, expect, mock, spyOn } from "bun:test";
import { Command } from "commander";
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
  RepoOptions,
  OutputOptions,
  TaskOptions,
  BackendOptions,
} from "../shared-options.js";

// Mock normalizeTaskId from domain to avoid external dependencies
mock.module("../../../../domain/tasks.js", () => ({
  normalizeTaskId: (taskId: string) => {
    if (!taskId) return null;
    // Simple mock implementation that handles format conversion
    if (taskId.startsWith("#")) {
      return taskId.substring(1);
    }
    return taskId;
  },
}));

describe("Shared CLI Options", () => {
  describe("Option Application Functions", () => {
    it("should add repository options to a command", () => {
      const command = new Command();
      const spy = spyOn(command, "option");

      addRepoOptions(command);

      // Verify the correct options were added
      expect(spy).toHaveBeenCalledTimes(3);
      expect(spy).toHaveBeenCalledWith(
        "--session <session>", 
        "Session name to use for repository resolution"
      );
      expect(spy).toHaveBeenCalledWith(
        "--repo <repositoryUri>", 
        "Repository URI (overrides session)"
      );
      expect(spy).toHaveBeenCalledWith(
        "--upstream-repo <upstreamRepoUri>",
        "URI of the upstream repository (overrides repo and session)"
      );
    });

    it("should add output format options to a command", () => {
      const command = new Command();
      const spy = spyOn(command, "option");

      addOutputOptions(command);

      // Verify the correct options were added
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenCalledWith("--json", "Output result as JSON");
      expect(spy).toHaveBeenCalledWith("--debug", "Enable debug output");
    });

    it("should add task identification options to a command", () => {
      const command = new Command();
      const spy = spyOn(command, "option");

      addTaskOptions(command);

      // Verify the correct options were added
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith("--task <taskId>", "Task ID to match");
    });

    it("should add backend options to a command", () => {
      const command = new Command();
      const spy = spyOn(command, "option");

      addBackendOptions(command);

      // Verify the correct options were added
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith("-b, --backend <backend>", "Specify backend type");
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
        task: "123",
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
        task: "123",
      });
    });
  });
}); 
