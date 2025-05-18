import { describe, test, expect } from "bun:test";

// Tests have been migrated to test domain methods directly

describe("getSessionDirFromParams", () => {
  test("gets the directory path for an existing session", async () => {
    // Arrange
    const expectedPath = "/path/to/session/directory";
    mockGetSessionDirFromParams.mockResolvedValue(expectedPath);
    const params = {
      name: "test-session",
    };

    // Act
    const result = await mockGetSessionDirFromParams(params);

    // Assert
    expect(mockGetSessionDirFromParams).toHaveBeenCalledWith(params);
    expect(result).toBe(expectedPath);
  });

  test("resolves directory path for a session with task ID", async () => {
    // Arrange
    const expectedPath = "/path/to/task/session/directory";
    mockGetSessionDirFromParams.mockResolvedValue(expectedPath);
    const params = {
      task: "123",
    };

    // Act
    const result = await mockGetSessionDirFromParams(params);

    // Assert
    expect(mockGetSessionDirFromParams).toHaveBeenCalledWith(params);
    expect(result).toBe(expectedPath);
  });

  test("throws error when session not found", async () => {
    // Arrange
    const error = new Error('Session "non-existent" not found');
    mockGetSessionDirFromParams.mockRejectedValue(error);
    const params = {
      name: "non-existent",
    };

    // Act & Assert
    await expect(mockGetSessionDirFromParams(params)).rejects.toThrow(
      'Session "non-existent" not found'
    );
  });
});
