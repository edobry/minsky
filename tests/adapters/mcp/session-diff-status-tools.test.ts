/**
 * Tests for session_diff and session_status MCP tools
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { registerSessionWorkspaceTools } from "../../../src/adapters/mcp/session-workspace";

describe("Session Diff and Status Tools", () => {
  let commandMapper: { addCommand: ReturnType<typeof mock> };
  let registeredTools: Record<
    string,
    { name: string; description: string; schema: unknown; handler: unknown }
  >;

  beforeEach(() => {
    registeredTools = {};

    const mockAddCommand = mock(
      (command: { name: string; description: string; parameters?: unknown; handler: unknown }) => {
        registeredTools[command.name] = {
          name: command.name,
          description: command.description,
          schema: command.parameters,
          handler: command.handler,
        };
      }
    );

    commandMapper = { addCommand: mockAddCommand };
    registerSessionWorkspaceTools(commandMapper as never);
  });

  describe("session.diff", () => {
    test("should be registered", () => {
      expect(registeredTools["session.diff"]).toBeDefined();
    });

    test("should have correct name", () => {
      expect(registeredTools["session.diff"]?.name).toBe("session.diff");
    });

    test("should have a description mentioning diff", () => {
      expect(registeredTools["session.diff"]?.description).toContain("diff");
    });

    test("should accept sessionId, optional path, and optional staged parameters", () => {
      const schema = registeredTools["session.diff"]?.schema as {
        _def?: { shape?: Record<string, unknown> };
      };
      expect(schema).toBeDefined();
      // Verify zod schema has expected shape
      const shape = schema?._def?.shape;
      expect(shape).toBeDefined();
      expect(shape?.["sessionId"]).toBeDefined();
      expect(shape?.["path"]).toBeDefined();
      expect(shape?.["staged"]).toBeDefined();
    });
  });

  describe("session.status", () => {
    test("should be registered", () => {
      expect(registeredTools["session.status"]).toBeDefined();
    });

    test("should have correct name", () => {
      expect(registeredTools["session.status"]?.name).toBe("session.status");
    });

    test("should have a description mentioning status", () => {
      expect(registeredTools["session.status"]?.description).toContain("status");
    });

    test("should accept sessionId parameter", () => {
      const schema = registeredTools["session.status"]?.schema as {
        _def?: { shape?: Record<string, unknown> };
      };
      expect(schema).toBeDefined();
      const shape = schema?._def?.shape;
      expect(shape).toBeDefined();
      expect(shape?.["sessionId"]).toBeDefined();
    });
  });
});
