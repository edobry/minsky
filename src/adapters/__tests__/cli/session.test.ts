// Import existing test block for session commands...

// Add a new test block for the session PR command
describe("session pr command", () => {
  const mockSessionPrFromParams = jest.fn();
  
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock the domain function
    mockSessionPrFromParams.mockResolvedValue({
      prBranch: "pr/test-branch",
      baseBranch: "main",
      title: "Test PR Title",
    });
    
    // Mock the module import
    jest.mock("../../../domain/index.js", () => ({
      ...jest.requireActual("../../../domain/index.js"),
      sessionPrFromParams: mockSessionPrFromParams,
    }));
  });
  
  it("should call sessionPrFromParams with correct parameters", async () => {
    // Arrange
    const { program } = setupProgram();
    const consoleSpy = jest.spyOn(console, "log");
    
    // Act
    await program.parseAsync(["node", "test", "session", "pr", "test-session", "--title", "Test PR Title"]);
    
    // Assert
    expect(mockSessionPrFromParams).toHaveBeenCalledWith({
      session: "test-session",
      title: "Test PR Title",
      debug: false,
      noStatusUpdate: false,
    });
    expect(consoleSpy).toHaveBeenCalledWith("Created PR branch pr/test-branch from base main");
  });
  
  it("should use task ID when provided", async () => {
    // Arrange
    const { program } = setupProgram();
    
    // Act
    await program.parseAsync(["node", "test", "session", "pr", "--task", "123"]);
    
    // Assert
    expect(mockSessionPrFromParams).toHaveBeenCalledWith(
      expect.objectContaining({
        session: undefined,
        task: "123",
      })
    );
  });
  
  it("should handle errors gracefully", async () => {
    // Arrange
    const { program } = setupProgram();
    const mockExit = jest.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const consoleErrorSpy = jest.spyOn(console, "error");
    
    // Mock implementation to throw error
    mockSessionPrFromParams.mockRejectedValue(new Error("Test error"));
    
    // Act
    await program.parseAsync(["node", "test", "session", "pr", "test-session"]);
    
    // Assert
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Test error"));
    expect(mockExit).toHaveBeenCalledWith(1);
  });
}); 
