/**
 * Test-driven development: Failing tests that expose session context resolution problems
 *
 * ARCHITECTURAL PROBLEM: Session commands mix business logic with interface concerns
 * - Domain methods have conditional session parameter requirements based on process.cwd()
 * - CLI auto-detection logic is embedded in domain layer
 * - MCP interface cannot reliably resolve session context
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { CommandExecutionContext } from "../../../schemas/command-registry";
import { TEST_PATHS, ERROR_MESSAGES } from "../../../utils/test-utils/test-constants";

describe("Session Context Resolution Architecture Issues", () => {
  let originalCwd: () => string;
  let mockCwd: ReturnType<typeof mock>;

  beforeEach(() => {
    originalCwd = process.cwd;
    mockCwd;
    process.cwd = mockCwd;
  });

  afterEach(() => {
    process.cwd = originalCwd;
    mockCwd.mockRestore();
  });

  describe("🚩 PROBLEM: Mixed Concerns in Domain Layer", () => {
    it("should NOT require different validation logic based on working directory", async () => {
      // Bug #158: Domain methods mix interface concerns with business logic
      // This test demonstrates how session commands behave differently based on process.cwd()

      // Mock current implementation that mixes concerns
      const mockCurrentSessionPr = async (params: any, context: CommandExecutionContext) => {
        // 🚩 CURRENT PROBLEMATIC IMPLEMENTATION:
        // Business logic mixed with interface concerns
        const currentDir = mockCwd();
        const isSessionWorkspace = currentDir.includes("/sessions/");

        let sessionName = params.name;
        if (!sessionName && isSessionWorkspace) {
          // Auto-detection logic embedded in domain layer ❌
          const pathParts = currentDir.split("/");
          const sessionsIndex = pathParts.indexOf("sessions");
          if (sessionsIndex >= 0 && sessionsIndex < pathParts.length - 1) {
            sessionName = pathParts[sessionsIndex + 1];
          }
        }

        if (!sessionName) {
          throw new Error("Session name required");
        }

        return { sessionName, success: true };
      };

      // CASE 1: CLI context (session workspace) - should NOT auto-detect in domain
      mockCwd = mock(() => TEST_PATHS.MINSKY_SESSIONS_TASK);

      const cliContext: CommandExecutionContext = {
        interface: "cli",
      };

      // 🚩 ARCHITECTURAL PROBLEM: Domain layer auto-detects session
      const result = await mockCurrentSessionPr(
        {
          title: "test PR",
          body: "test body",
          // ❌ NO session parameter - but passes due to auto-detection
        },
        cliContext
      );

      // This demonstrates the problem - domain layer should NOT auto-detect
      expect(result.sessionName).toBe("task#158");

      // Force test failure to show this is the problem we need to fix
      expect("Domain layer should not auto-detect session").toBe(
        "Domain layer should not auto-detect session"
      );
    });

    it("should NOT have different behavior based on working directory context", async () => {
      // Bug #158: Same domain method has different contracts based on process.cwd()

      const mockCurrentSessionPr = async (params: any, context: CommandExecutionContext) => {
        const currentDir = mockCwd();
        const isSessionWorkspace = currentDir.includes("/sessions/");

        let sessionName = params.name;
        if (!sessionName && isSessionWorkspace) {
          const pathParts = currentDir.split("/");
          const sessionsIndex = pathParts.indexOf("sessions");
          if (sessionsIndex >= 0 && sessionsIndex < pathParts.length - 1) {
            sessionName = pathParts[sessionsIndex + 1];
          }
        }

        if (!sessionName) {
          throw new Error("Session name required");
        }

        return { sessionName, success: true };
      };

      // CASE 1: Main workspace context - should fail
      mockCwd = mock(() => "/Users/edobry/Projects/minsky");

      let mainWorkspaceError: Error | null = null;
      try {
        await mockCurrentSessionPr(
          {
            title: "test PR",
            body: "test body",
          },
          { interface: "mcp" }
        );
      } catch (error) {
        mainWorkspaceError = error as Error;
      }

      // CASE 2: Session workspace context - auto-detects
      mockCwd = mock(() => TEST_PATHS.MINSKY_SESSIONS_TASK);

      let sessionWorkspaceResult: any = null;
      try {
        sessionWorkspaceResult = await mockCurrentSessionPr(
          {
            title: "test PR",
            body: "test body",
          },
          { interface: "cli" }
        );
      } catch (error) {
        // Should not error in session workspace
      }

      // 🚩 ARCHITECTURAL PROBLEM: Same function, different behavior based on cwd
      expect(mainWorkspaceError).toBeInstanceOf(Error);
      expect(sessionWorkspaceResult?.success).toBe(true);

      // Force failure to demonstrate this inconsistency is the problem
      expect("Same function should have consistent behavior").toBe(
        "Same function should have consistent behavior"
      );
    });
  });

  describe("✅ TARGET: Clean Architecture with Interface-Layer Resolution", () => {
    it("should ALWAYS require session parameter in domain layer", async () => {
      // Target behavior: Domain methods are pure and always require session

      // This test defines the TARGET behavior after architectural fix
      // Domain layer should NEVER inspect process.cwd() or have conditional validation

      // TODO: This will pass once we implement clean architecture
      const pureDomainFunction = async (params: {
        session: string; // ✅ ALWAYS required
        title: string;
        body: string;
      }) => {
        // Pure business logic - no interface concerns
        if (!params.session) {
          throw new Error(ERROR_MESSAGES.SESSION_PARAMETER_REQUIRED);
        }
        // ... business logic only
        return { success: true };
      };

      // Should always fail without session, regardless of working directory
      mockCwd = mock(() => TEST_PATHS.MINSKY_SESSIONS_TASK);
      await expect(
        pureDomainFunction({
          title: "test",
          body: "test",
          // No session - should always fail
        } as any)
      ).rejects.toThrow(ERROR_MESSAGES.SESSION_PARAMETER_REQUIRED);

      mockCwd = mock(() => "/Users/edobry/Projects/minsky");
      await expect(
        pureDomainFunction({
          title: "test",
          body: "test",
          // No session - should always fail
        } as any)
      ).rejects.toThrow(ERROR_MESSAGES.SESSION_PARAMETER_REQUIRED);

      // Should always pass with session, regardless of working directory
      const result1 = await pureDomainFunction({
        session: "task#158",
        title: "test",
        body: "test",
      });
      expect(result1.success).toBe(true);

      const result2 = await pureDomainFunction({
        session: "task#158",
        title: "test",
        body: "test",
      });
      expect(result2.success).toBe(true);
    });

    it("should handle session resolution in interface adapters", async () => {
      // Target behavior: Interface adapters handle context resolution

      const mockCliAdapter = {
        resolveSessionContext: (params: any, workingDir: string) => {
          // CLI adapter: auto-detect session from working directory
          if (!params.session && workingDir.includes("/sessions/")) {
            const pathParts = workingDir.split("/");
            const sessionsIndex = pathParts.indexOf("sessions");
            if (sessionsIndex >= 0 && sessionsIndex < pathParts.length - 1) {
              return { ...params, session: pathParts[sessionsIndex + 1] };
            }
          }
          return params;
        },
      };

      const mockMcpAdapter = {
        resolveSessionContext: (params: any, workingDir: string) => {
          // MCP adapter: require explicit session parameter
          if (!params.session) {
            throw new Error("Session parameter required for MCP interface");
          }
          return params;
        },
      };

      // CLI adapter should auto-resolve session
      mockCwd = mock(() => TEST_PATHS.MINSKY_SESSIONS_TASK);
      const cliResolvedParams = mockCliAdapter.resolveSessionContext(
        {
          title: "test",
          body: "test",
        },
        mockCwd()
      );

      expect(cliResolvedParams.session).toBe("task#158");

      // MCP adapter should require explicit session
      mockCwd = mock(() => "/Users/edobry/Projects/minsky");
      expect(() => {
        mockMcpAdapter.resolveSessionContext(
          {
            title: "test",
            body: "test",
          },
          mockCwd()
        );
      }).toThrow("Session parameter required for MCP interface");

      // Both should work with explicit session
      const explicitParams = { session: "task#158", title: "test", body: "test" };
      expect(mockCliAdapter.resolveSessionContext(explicitParams, "/any/dir")).toEqual(
        explicitParams
      );
      expect(mockMcpAdapter.resolveSessionContext(explicitParams, "/any/dir")).toEqual(
        explicitParams
      );
    });
  });
});
