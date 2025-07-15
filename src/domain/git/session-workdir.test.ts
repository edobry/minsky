/**
 * Tests for GitService session workdir functionality
 * @migrated Extracted from git.test.ts for focused responsibility
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { GitService } from "../git";
import {
  createMock,
  setupTestMocks,
  mockModule,
} from "../../utils/test-utils/mocking";

// Set up automatic mock cleanup
setupTestMocks();

// Mock the logger module to avoid winston dependency issues
mockModule("../../utils/logger", () => ({
  log: {
    agent: createMock(),
    debug: createMock(),
    warn: createMock(),
    error: createMock(),
    cli: createMock(),
    cliWarn: createMock(),
    cliError: createMock(),
    setLevel: createMock(),
    cliDebug: createMock(),
  },
}));

// Mock the centralized execAsync module at the top level for proper module interception
const mockExecAsync = createMock();
mockModule("../../utils/exec", () => ({
  execAsync: mockExecAsync,
}));

describe("GitService - Session Workdir Tests", () => {
  let gitService: GitService;

  beforeEach(() => {
    gitService = new GitService("/test/base/dir");
    mockExecAsync.mockReset();
  });

  test("getSessionWorkdir should return the correct path", () => {
    const workdir = gitService.getSessionWorkdir("test-session");

    // NEW: Session-ID-based storage - expect session ID in path, not repo name
    expect(workdir.includes("test-session")).toBe(true);
    expect(workdir.includes("sessions")).toBe(true);
    // Repository identity no longer part of filesystem path
  });

  test("should use session-ID-based storage in getSessionWorkdir", () => {
    // NEW: Session-ID-based storage - repository normalization no longer needed for paths
    const workdir1 = gitService.getSessionWorkdir("test-session");

    // Path should contain session ID but NOT repository name
    expect(workdir1.includes("test-session")).toBe(true);
    expect(workdir1.includes("sessions")).toBe(true);
    expect(workdir1.endsWith("sessions/test-session")).toBe(true);
  });
}); 
