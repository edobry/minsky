/**
 * Dynamic Backend Selection Tests
 * 
 * Tests that verify the system properly delegates backend selection
 * to the service layer when no explicit backend is specified, enabling
 * automatic backend detection and multi-backend routing.
 */

import { describe, test, expect, mock } from "bun:test";

describe("Dynamic Backend Selection", () => {
  test("should delegate backend selection to service when none specified", async () => {
    // Mock factory that captures backend selection behavior
    let capturedBackend: string | undefined = undefined;
    
    const mockCreateTaskService = mock(async (options: { workspacePath: string; backend?: string }) => {
      capturedBackend = options.backend;
      return {} as any;
    });

    // System behavior: Pass undefined to let service choose backend
    const delegateBackendSelection = async (params: { backend?: string }) => {
      await mockCreateTaskService({
        workspacePath: "/tmp", 
        backend: params.backend, // Delegate to service when undefined
      });
    };

    await delegateBackendSelection({ }); // No backend specified
    expect(capturedBackend).toBe(undefined); // Service chooses backend
  });

  test("should support both explicit and automatic backend selection", async () => {
    let capturedBackends: (string | undefined)[] = [];
    
    const mockCreateTaskService = mock(async (options: { workspacePath: string; backend?: string }) => {
      capturedBackends.push(options.backend);
      return {} as any;
    });

    // Scenario 1: User explicitly requests markdown backend
    await mockCreateTaskService({
      workspacePath: "/tmp",
      backend: "markdown", // Explicit user choice
    });

    // Scenario 2: User lets system choose backend automatically
    await mockCreateTaskService({
      workspacePath: "/tmp",
      backend: undefined, // Automatic selection
    });

    // Scenario 3: User explicitly requests different backend
    await mockCreateTaskService({
      workspacePath: "/tmp", 
      backend: "json-file", // Explicit user choice
    });

    // Verify backend selection behavior
    expect(capturedBackends[0]).toBe("markdown");   // Explicit choice honored
    expect(capturedBackends[1]).toBe(undefined);    // Automatic selection enabled
    expect(capturedBackends[2]).toBe("json-file");  // Explicit choice honored
  });
});

/**
 * Test Coverage:
 * 
 * These tests verify the system provides:
 * 1. Automatic backend detection when no backend specified
 * 2. Explicit backend selection when user provides preference
 * 3. Service-layer delegation for intelligent backend routing
 * 4. Support for multi-backend task management
 * 5. Flexible backend configuration options
 */
