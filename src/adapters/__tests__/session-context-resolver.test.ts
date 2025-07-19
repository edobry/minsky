/**
 * Tests for Interface-Layer Session Context Resolution
 * Verifies the clean architecture solution
 */

import { describe, it, expect } from "bun:test";
import { 
  CLISessionContextResolver,
  MCPSessionContextResolver,
  SessionContextResolverFactory,
  resolveSessionForInterface
} from "../session-context-resolver";
import { ValidationError } from "../../errors/index";

describe("Interface-Layer Session Context Resolution", () => {
  
  describe("CLI Session Context Resolver", () => {
    it("should use explicit name when provided", () => {
      const params = { name: "explicit-session", title: "test" };
      const result = CLISessionContextResolver.resolveSessionContext(params);
      
      expect(result.session).toBe("explicit-session");
      expect(result.title).toBe("test");
    });

    it("should auto-detect session from session workspace path", () => {
      const params = { title: "test" };
      const workingDir = "/Users/edobry/.local/state/minsky/sessions/task#158";
      
      const result = CLISessionContextResolver.resolveSessionContext(params, workingDir);
      
      expect(result.session).toBe("task#158");
      expect(result.title).toBe("test");
    });

    it("should return params unchanged if no session can be detected", () => {
      const params = { title: "test" };
      const workingDir = "/Users/edobry/Projects/minsky";
      
      const result = CLISessionContextResolver.resolveSessionContext(params, workingDir);
      
      expect(result.session).toBeUndefined();
      expect(result.title).toBe("test");
    });

    it("should prefer explicit name over auto-detection", () => {
      const params = { name: "explicit-session", title: "test" };
      const workingDir = "/Users/edobry/.local/state/minsky/sessions/task#158";
      
      const result = CLISessionContextResolver.resolveSessionContext(params, workingDir);
      
      expect(result.session).toBe("explicit-session");
      expect(result.title).toBe("test");
    });

    it("should use explicit task parameter for session identification", () => {
      const params = { task: "158", title: "test" };
      const result = CLISessionContextResolver.resolveSessionContext(params);
      
      expect(result.session).toBe("158");
      expect(result.task).toBe("158");
      expect(result.title).toBe("test");
    });

    it("should prefer name over task when both are provided", () => {
      const params = { name: "task#158", task: "158", title: "test" };
      const result = CLISessionContextResolver.resolveSessionContext(params);
      
      expect(result.session).toBe("task#158");
      expect(result.name).toBe("task#158");
      expect(result.task).toBe("158");
      expect(result.title).toBe("test");
    });
  });

  describe("MCP Session Context Resolver", () => {
    it("should use explicit session when provided", () => {
      const params = { session: "task#158", title: "test" };
      const result = MCPSessionContextResolver.resolveSessionContext(params);
      
      expect(result.session).toBe("task#158");
      expect(result.title).toBe("test");
    });

    it("should throw ValidationError when no session provided", () => {
      const params = { title: "test" };
      
      expect(() => {
        MCPSessionContextResolver.resolveSessionContext(params);
      }).toThrow(ValidationError);
      
      expect(() => {
        MCPSessionContextResolver.resolveSessionContext(params);
      }).toThrow("Session parameter required for MCP interface");
    });

    it("should not auto-detect even in session workspace", () => {
      const params = { title: "test" };
      const workingDir = "/Users/edobry/.local/state/minsky/sessions/task#158";
      
      expect(() => {
        MCPSessionContextResolver.resolveSessionContext(params, workingDir);
      }).toThrow(ValidationError);
    });

    it("should use explicit task parameter for session identification", () => {
      const params = { task: "158", title: "test" };
      const result = MCPSessionContextResolver.resolveSessionContext(params);
      
      expect(result.session).toBe("158");
      expect(result.task).toBe("158");
      expect(result.title).toBe("test");
    });

    it("should prefer name over task when both are provided", () => {
      const params = { name: "task#158", task: "158", title: "test" };
      const result = MCPSessionContextResolver.resolveSessionContext(params);
      
      expect(result.session).toBe("task#158");
      expect(result.name).toBe("task#158");
      expect(result.task).toBe("158");
      expect(result.title).toBe("test");
    });
  });

  describe("Session Context Resolver Factory", () => {
    it("should return CLI resolver for 'cli' interface", () => {
      const resolver = SessionContextResolverFactory.getResolver("cli");
      expect(resolver).toBe(CLISessionContextResolver);
    });

    it("should return MCP resolver for 'mcp' interface", () => {
      const resolver = SessionContextResolverFactory.getResolver("mcp");
      expect(resolver).toBe(MCPSessionContextResolver);
    });

    it("should default to MCP resolver for unknown interfaces", () => {
      const resolver = SessionContextResolverFactory.getResolver("unknown");
      expect(resolver).toBe(MCPSessionContextResolver);
    });

    it("should resolve session context based on interface type", () => {
      // CLI interface should auto-detect
      const cliResult = SessionContextResolverFactory.resolveSessionContext(
        { title: "test" },
        "cli",
        "/Users/edobry/.local/state/minsky/sessions/task#158"
      );
      expect(cliResult.session).toBe("task#158");

      // MCP interface should require explicit session
      expect(() => {
        SessionContextResolverFactory.resolveSessionContext(
          { title: "test" },
          "mcp",
          "/Users/edobry/.local/state/minsky/sessions/task#158"
        );
      }).toThrow(ValidationError);
    });
  });

  describe("resolveSessionForInterface helper", () => {
    it("should resolve CLI session context successfully", () => {
      const result = resolveSessionForInterface(
        { title: "test" },
        "cli",
        "/Users/edobry/.local/state/minsky/sessions/task#158"
      );
      
      expect(result.session).toBe("task#158");
      expect(result.title).toBe("test");
    });

    it("should resolve MCP session context with explicit session", () => {
      const result = resolveSessionForInterface(
        { session: "task#158", title: "test" },
        "mcp"
      );
      
      expect(result.session).toBe("task#158");
      expect(result.title).toBe("test");
    });

    it("should throw ValidationError when MCP has no session", () => {
      expect(() => {
        resolveSessionForInterface(
          { title: "test" },
          "mcp"
        );
      }).toThrow(ValidationError);
    });

    it("should throw ValidationError when CLI can't detect session", () => {
      expect(() => {
        resolveSessionForInterface(
          { title: "test" },
          "cli",
          "/Users/edobry/Projects/minsky"
        );
      }).toThrow(ValidationError);
    });
  });
}); 
