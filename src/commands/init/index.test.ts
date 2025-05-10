import { describe, test, expect, mock, spyOn } from "bun:test";
import { createInitCommand } from "./index";
import * as p from "@clack/prompts";
import { initializeProject } from "../../domain/init";
import { resolveRepoPath } from "../../utils/repo";

// Mock modules
mock.module("@clack/prompts", () => ({
  intro: mock.fn(),
  outro: mock.fn(),
  confirm: mock.fn(),
  select: mock.fn(),
  text: mock.fn(),
  isCancel: mock.fn().mockImplementation(val => val === Symbol.for("clack.cancel")),
  cancel: mock.fn(),
}));

mock.module("../../domain/init", () => ({
  initializeProject: mock.fn().mockResolvedValue(undefined),
}));

mock.module("../../utils/repo", () => ({
  resolveRepoPath: mock.fn().mockResolvedValue("/mocked/repo/path"),
}));

// Mock process.exit to prevent actual exit
const realExit = process.exit;
process.exit = mock.fn() as any;

describe("createInitCommand", () => {
  let command: ReturnType<typeof createInitCommand>;
  
  beforeEach(() => {
    // Reset mocks before each test
    mock.restoreAll();
    
    // Mock process.exit
    process.exit = mock.fn() as any;
    
    // Create the command
    command = createInitCommand();
    
    // Setup default mocks
    (p.confirm as any).mockResolvedValue(true);
    (p.select as any).mockResolvedValue("tasks.md");
  });
  
  afterAll(() => {
    // Restore process.exit
    process.exit = realExit;
  });

  test("should initialize project with default MCP settings when not specified", async () => {
    // Setup mocks
    (resolveRepoPath as any).mockResolvedValue("/test/repo");
    (p.select as any)
      .mockResolvedValueOnce("tasks.md") // backend
      .mockResolvedValueOnce("cursor");  // ruleFormat
    (p.confirm as any)
      .mockResolvedValueOnce(true)       // repo confirm
      .mockResolvedValueOnce(true);      // mcp enabled
    (p.select as any)
      .mockResolvedValueOnce("stdio");   // mcp transport
    
    // Run the command
    await command.parseAsync(["node", "minsky", "init"]);
    
    // Verify initializeProject was called with correct args
    expect(initializeProject).toHaveBeenCalledWith({
      repoPath: "/test/repo",
      backend: "tasks.md",
      ruleFormat: "cursor",
      mcp: {
        enabled: true,
        transport: "stdio",
        port: undefined,
        host: undefined
      }
    });
  });

  test("should initialize project with MCP disabled when --mcp false is provided", async () => {
    // Setup mocks
    (resolveRepoPath as any).mockResolvedValue("/test/repo");
    
    // Run the command
    await command.parseAsync([
      "node", 
      "minsky", 
      "init", 
      "--backend", "tasks.md", 
      "--rule-format", "cursor", 
      "--mcp", "false"
    ]);
    
    // Verify initializeProject was called with correct args
    expect(initializeProject).toHaveBeenCalledWith({
      repoPath: "/test/repo",
      backend: "tasks.md",
      ruleFormat: "cursor",
      mcp: {
        enabled: false,
        transport: "stdio"
      }
    });
  });

  test("should initialize project with custom MCP transport and network settings", async () => {
    // Setup mocks
    (resolveRepoPath as any).mockResolvedValue("/test/repo");
    
    // Run the command
    await command.parseAsync([
      "node", 
      "minsky", 
      "init", 
      "--backend", "tasks.md", 
      "--rule-format", "cursor", 
      "--mcp", "true",
      "--mcp-transport", "sse",
      "--mcp-port", "9000",
      "--mcp-host", "127.0.0.1"
    ]);
    
    // Verify initializeProject was called with correct args
    expect(initializeProject).toHaveBeenCalledWith({
      repoPath: "/test/repo",
      backend: "tasks.md",
      ruleFormat: "cursor",
      mcp: {
        enabled: true,
        transport: "sse",
        port: 9000,
        host: "127.0.0.1"
      }
    });
  });

  test("should handle interactive MCP configuration", async () => {
    // Setup mocks
    (resolveRepoPath as any).mockResolvedValue("/test/repo");
    (p.select as any)
      .mockResolvedValueOnce("tasks.md") // backend
      .mockResolvedValueOnce("cursor")   // ruleFormat
      .mockResolvedValueOnce("sse");     // mcp transport
    (p.confirm as any)
      .mockResolvedValueOnce(true)       // repo confirm
      .mockResolvedValueOnce(true);      // mcp enabled
    (p.text as any)
      .mockResolvedValueOnce("8888")     // port
      .mockResolvedValueOnce("0.0.0.0"); // host
    
    // Run the command
    await command.parseAsync(["node", "minsky", "init"]);
    
    // Verify initializeProject was called with correct args
    expect(initializeProject).toHaveBeenCalledWith({
      repoPath: "/test/repo",
      backend: "tasks.md",
      ruleFormat: "cursor",
      mcp: {
        enabled: true,
        transport: "sse",
        port: 8888,
        host: "0.0.0.0"
      }
    });
  });

  test("should not prompt for network settings when stdio transport is selected", async () => {
    // Setup mocks
    (resolveRepoPath as any).mockResolvedValue("/test/repo");
    (p.select as any)
      .mockResolvedValueOnce("tasks.md")  // backend
      .mockResolvedValueOnce("cursor")    // ruleFormat
      .mockResolvedValueOnce("stdio");    // mcp transport
    (p.confirm as any)
      .mockResolvedValueOnce(true)        // repo confirm
      .mockResolvedValueOnce(true);       // mcp enabled
    const textSpy = spyOn(p, "text");
    
    // Run the command
    await command.parseAsync(["node", "minsky", "init"]);
    
    // Verify text prompt wasn't called for port/host
    expect(textSpy).not.toHaveBeenCalled();
    
    // Verify initializeProject was called with correct args
    expect(initializeProject).toHaveBeenCalledWith({
      repoPath: "/test/repo",
      backend: "tasks.md",
      ruleFormat: "cursor",
      mcp: {
        enabled: true,
        transport: "stdio",
        port: undefined,
        host: undefined
      }
    });
  });

  test("should not prompt for MCP options when --mcp false is provided", async () => {
    // Setup mocks
    (resolveRepoPath as any).mockResolvedValue("/test/repo");
    (p.select as any)
      .mockResolvedValueOnce("tasks.md")  // backend
      .mockResolvedValueOnce("cursor");   // ruleFormat
    const confirmSpy = spyOn(p, "confirm");
    const selectSpy = spyOn(p, "select");
    
    // Set initial call counts after setting up mocks
    const initialConfirmCalls = confirmSpy.mock.calls.length;
    const initialSelectCalls = selectSpy.mock.calls.length;
    
    // Run the command
    await command.parseAsync([
      "node", 
      "minsky", 
      "init", 
      "--mcp", "false"
    ]);
    
    // Verify no additional MCP prompts were shown
    expect(confirmSpy.mock.calls.length).toBe(initialConfirmCalls + 1); // Only repo confirm
    expect(selectSpy.mock.calls.length).toBe(initialSelectCalls + 2);   // Only backend and rule format
    
    // Verify initializeProject was called with MCP disabled
    expect(initializeProject).toHaveBeenCalledWith(
      expect.objectContaining({
        mcp: {
          enabled: false,
          transport: "stdio"
        }
      })
    );
  });
}); 
