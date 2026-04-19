import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  detectAgentHarness,
  hasNativeSubagentSupport,
} from "../../../src/domain/runtime/harness-detection";

describe("detectAgentHarness", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "CLAUDE_CODE",
    "CLAUDE_PROJECT_DIR",
    "CURSOR_SESSION_ID",
    "CURSOR_TRACE_ID",
    "VSCODE_PID",
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it("detects claude-code from CLAUDE_CODE env", () => {
    process.env.CLAUDE_CODE = "1";
    expect(detectAgentHarness()).toBe("claude-code");
  });

  it("detects claude-code from CLAUDE_PROJECT_DIR env", () => {
    process.env.CLAUDE_PROJECT_DIR = "/some/path";
    expect(detectAgentHarness()).toBe("claude-code");
  });

  it("detects cursor from CURSOR_SESSION_ID env", () => {
    process.env.CURSOR_SESSION_ID = "abc123";
    expect(detectAgentHarness()).toBe("cursor");
  });

  it("detects cursor from VSCODE_PID env", () => {
    process.env.VSCODE_PID = "12345";
    expect(detectAgentHarness()).toBe("cursor");
  });

  it("returns standalone when no harness env vars set", () => {
    expect(detectAgentHarness()).toBe("standalone");
  });

  it("claude-code takes priority over cursor", () => {
    process.env.CLAUDE_CODE = "1";
    process.env.VSCODE_PID = "12345";
    expect(detectAgentHarness()).toBe("claude-code");
  });
});

describe("hasNativeSubagentSupport", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "CLAUDE_CODE",
    "CLAUDE_PROJECT_DIR",
    "CURSOR_SESSION_ID",
    "CURSOR_TRACE_ID",
    "VSCODE_PID",
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it("returns true for claude-code", () => {
    process.env.CLAUDE_CODE = "1";
    expect(hasNativeSubagentSupport()).toBe(true);
  });

  it("returns false for cursor (not yet supported)", () => {
    process.env.CURSOR_SESSION_ID = "abc";
    expect(hasNativeSubagentSupport()).toBe(false);
  });

  it("returns false for standalone", () => {
    expect(hasNativeSubagentSupport()).toBe(false);
  });
});
