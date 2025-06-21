/**
 * Tests for session file operation tools
 */
import { describe, it, expect } from "bun:test";
import { registerSessionFileTools, SessionPathResolver } from "../session-files";

describe("Session File Tools", () => {
  it("should export registerSessionFileTools function", () => {
    expect(typeof registerSessionFileTools).toBe("function");
  });

  it("should export SessionPathResolver class", () => {
    expect(typeof SessionPathResolver).toBe("function");
    const resolver = new SessionPathResolver();
    expect(resolver).toBeDefined();
  });
});
