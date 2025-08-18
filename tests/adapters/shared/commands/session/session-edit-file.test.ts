/**
 * Tests for session edit-file command
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { SessionEditFileCommand } from "../../../../../src/adapters/shared/commands/session/file-commands";

describe("SessionEditFileCommand", () => {
  let command: SessionEditFileCommand;
  
  beforeEach(() => {
    command = new SessionEditFileCommand();
  });

  describe("command properties", () => {
    test("should have correct command id", () => {
      expect(command.getCommandId()).toBe("session.edit-file");
    });

    test("should have correct command name", () => {
      expect(command.getCommandName()).toBe("edit-file");
    });

    test("should have descriptive command description", () => {
      const description = command.getCommandDescription();
      expect(description).toContain("Edit a file");
      expect(description).toContain("session workspace");
    });

    test("should have parameter schema", () => {
      const schema = command.getParameterSchema();
      expect(schema).toBeDefined();
      expect(schema.path).toBeDefined();
      expect(schema.instruction).toBeDefined();
      expect(schema.session).toBeDefined();
      expect(schema.dryRun).toBeDefined();
    });
  });

  describe("parameter validation", () => {
    test("should have required path parameter", () => {
      const schema = command.getParameterSchema();
      expect(schema.path.required).toBe(true);
    });

    test("should have required instruction parameter", () => {
      const schema = command.getParameterSchema();
      expect(schema.instruction.required).toBe(true);
    });

    test("should have optional session parameter", () => {
      const schema = command.getParameterSchema();
      expect(schema.session.required).toBe(false);
    });

    test("should have optional dryRun parameter with default false", () => {
      const schema = command.getParameterSchema();
      expect(schema.dryRun.required).toBe(false);
      expect(schema.dryRun.defaultValue).toBe(false);
    });

    test("should have optional createDirs parameter with default true", () => {
      const schema = command.getParameterSchema();
      expect(schema.createDirs.required).toBe(false);
      expect(schema.createDirs.defaultValue).toBe(true);
    });
  });
});