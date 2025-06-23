import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { sessionPrFromParams } from "../session.js";
import { writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { ValidationError } from "../../errors/index.js";

const TEST_VALUE = 123;

// Mock dependencies
const mockPreparePrFromParams = mock();
const mockGetSession = mock();
const mockGetSessionByTaskId = mock();
const mockSetTaskStatus = mock();

mock.module("../git.js", () => ({
  preparePrFromParams: mockPreparePrFromParams,
}));

mock.module("../session.js", () => {
  const originalModule = {};
  return {
    ...originalModule,
    SessionDB: class MockSessionDB {
      getSession = mockGetSession;
      getSessionByTaskId = mockGetSessionByTaskId;
    },
    sessionPrFromParams: sessionPrFromParams,
  };
});

mock.module("../tasks.js", () => ({
  TaskService: class MockTaskService {
    setTaskStatus = mockSetTaskStatus;
  },
  TASK_STATUS: { IN_REVIEW: "IN-REVIEW" },
}));

describe("sessionPrFromParams bodyPath functionality", () => {
  const testDir = "/tmp/minsky-test-body-path";
  const testFilePath = join(testDir, "test-body.txt");
  const testContent = "This is the PR body content from file";

  beforeEach(async () => {
    // Setup test directory and file
    await mkdir(testDir, { recursive: true });
    await writeFile(testFilePath, testContent);

    // Reset mocks
    mock.restore();
    mockPreparePrFromParams.mockResolvedValue({
      prBranch: "pr/test-branch",
      baseBranch: "main",
      _title: "Test PR",
      body: testContent,
    });
    mockGetSession.mockResolvedValue({ taskId: "TEST_VALUE" });
    mockGetSessionByTaskId.mockResolvedValue({ _session: "test-session" });
    mockSetTaskStatus.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    // Clean up test directory
    await rm(testDir, { recursive: true, force: true });
  });

  test("should read body content from bodyPath when provided", async () => {
    const params = {
      session: "test-session",
      title: "Test PR",
      bodyPath: testFilePath,
      debug: false,
      noStatusUpdate: false,
    };

    await sessionPrFromParams(params);

    // Verify the body content was read from file and passed to preparePrFromParams
    expect(mockPreparePrFromParams).toHaveBeenCalledWith({
      _session: "test-session",
      _title: "Test PR",
      body: testContent,
      baseBranch: undefined,
      debug: false,
    });
  });

  test("should prioritize direct body over bodyPath when both are provided", async () => {
    // Reset mock to ensure clean state
    mockPreparePrFromParams.mockClear();
    mockPreparePrFromParams.mockResolvedValue({
      prBranch: "pr/test-branch",
      baseBranch: "main",
      _title: "Test PR",
      body: "Direct body content",
    });

    const directBody = "Direct body content";
    const params = {
      session: "test-session",
      title: "Test PR",
      body: directBody,
      bodyPath: testFilePath,
      debug: false,
      noStatusUpdate: false,
    };

    await sessionPrFromParams(params);

    // Should use direct body, not file content
    expect(mockPreparePrFromParams).toHaveBeenCalledTimes(1);
    expect(mockPreparePrFromParams).toHaveBeenCalledWith({
      _session: "test-session",
      _title: "Test PR",
      body: directBody,
      baseBranch: undefined,
      debug: false,
    });
  });

  test("should throw ValidationError when bodyPath file does not exist", async () => {
    const nonExistentPath = join(testDir, "non-existent.txt");
    const params = {
      session: "test-session",
      title: "Test PR",
      bodyPath: nonExistentPath,
      debug: false,
      noStatusUpdate: false,
    };

    await expect(sessionPrFromParams(params)).rejects.toThrow(ValidationError);
    await expect(sessionPrFromParams(params)).rejects.toThrow("Body file not found");
  });

  test("should throw ValidationError when bodyPath file is empty", async () => {
    const emptyFilePath = join(testDir, "empty.txt");
    await writeFile(emptyFilePath, "");

    const params = {
      session: "test-session",
      title: "Test PR",
      bodyPath: emptyFilePath,
      debug: false,
      noStatusUpdate: false,
    };

    await expect(sessionPrFromParams(params)).rejects.toThrow(ValidationError);
    await expect(sessionPrFromParams(params)).rejects.toThrow("Body file is empty");
  });

  test("should work with relative paths for bodyPath", async () => {
    // Create file in current working directory for relative path test
    const cwd = process.cwd();
    const relativeFilePath = "test-relative-body.txt";
    const absolutePath = join(cwd, relativeFilePath);
    await writeFile(absolutePath, testContent);

    try {
      const params = {
        session: "test-session",
        title: "Test PR",
        bodyPath: relativeFilePath,
        debug: false,
        noStatusUpdate: false,
      };

      await sessionPrFromParams(params);

      expect(mockPreparePrFromParams).toHaveBeenCalledWith({
        _session: "test-session",
        _title: "Test PR",
        body: testContent,
        baseBranch: undefined,
        debug: false,
      });
    } finally {
      // Clean up the relative file
      await rm(absolutePath, { force: true });
    }
  });
}); 
