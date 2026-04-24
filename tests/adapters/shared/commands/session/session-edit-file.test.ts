/**
 * Tests for session edit-file command
 */
import { describe, test, expect } from "bun:test";
import { createSessionEditFileCommand } from "../../../../../src/adapters/shared/commands/session/file-commands";
import type { SessionCommandDependencies } from "../../../../../src/adapters/shared/commands/session/types";

describe("session edit-file command definition", () => {
  // The factory only constructs the command definition; execute is never invoked
  // in this suite, so an empty deps thunk is sufficient.
  const deps = {} as SessionCommandDependencies;
  const command = createSessionEditFileCommand(() => Promise.resolve(deps));

  describe("command properties", () => {
    test("should have correct command id", () => {
      expect(command.id).toBe("session.edit-file");
    });

    test("should have correct command name", () => {
      expect(command.name).toBe("edit-file");
    });

    test("should have descriptive command description", () => {
      expect(command.description).toContain("Edit a file");
      expect(command.description).toContain("session workspace");
    });

    test("should have parameter schema", () => {
      const schema = command.parameters as Record<string, any>;
      expect(schema).toBeDefined();
      expect(schema.path).toBeDefined();
      expect(schema.instruction).toBeDefined();
      expect(schema.sessionId).toBeDefined();
      expect(schema.dryRun).toBeDefined();
    });
  });

  describe("parameter validation", () => {
    const schema = command.parameters as Record<string, any>;

    test("should have required path parameter", () => {
      expect(schema.path.required).toBe(true);
    });

    test("should have optional instruction parameter", () => {
      expect(schema.instruction.required).toBe(false);
    });

    test("should have optional session parameter", () => {
      expect(schema.sessionId.required).toBe(false);
    });

    test("should have optional dryRun parameter with default false", () => {
      expect(schema.dryRun.required).toBe(false);
      expect(schema.dryRun.defaultValue).toBe(false);
    });

    test("should have optional createDirs parameter with default true", () => {
      expect(schema.createDirs.required).toBe(false);
      expect(schema.createDirs.defaultValue).toBe(true);
    });
  });
});
