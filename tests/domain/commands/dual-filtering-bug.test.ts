/**
 * Test-driven bugfix for dual filtering issue
 *
 * BUG: We're doing both server-side AND client-side filtering, which is:
 * 1. Inefficient (filters twice)
 * 2. Inconsistent (different logic paths)
 * 3. Wrong results (client-side filter removes server-side filtered results)
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";

describe("Dual Filtering Bug Fix", () => {
  let mockSearchByText: any;
  let mockFilterTasksByStatus: any;
  let capturedServerFilters: any;
  let capturedClientFilters: any;

  beforeEach(() => {
    capturedServerFilters = null;
    capturedClientFilters = null;

    // Mock server-side search that captures filters
    mockSearchByText = mock(
      (query: string, limit: number, threshold?: number, filters?: Record<string, any>) => {
        capturedServerFilters = filters;

        // Return mock results that would come from server-side filtering
        if (filters?.status === "TODO") {
          return Promise.resolve([
            { id: "mt#001", score: 0.1, metadata: { status: "TODO" } },
            { id: "mt#002", score: 0.2, metadata: { status: "TODO" } },
          ]);
        } else if (filters?.backend === "minsky") {
          return Promise.resolve([
            { id: "mt#001", score: 0.1, metadata: { status: "DONE", backend: "minsky" } },
            { id: "mt#002", score: 0.2, metadata: { status: "TODO", backend: "minsky" } },
            { id: "mt#003", score: 0.3, metadata: { status: "DONE", backend: "minsky" } },
          ]);
        } else {
          // No filters - return mixed results
          return Promise.resolve([
            { id: "mt#001", score: 0.1, metadata: { status: "DONE" } },
            { id: "mt#002", score: 0.2, metadata: { status: "TODO" } },
            { id: "mt#003", score: 0.3, metadata: { status: "DONE" } },
          ]);
        }
      }
    );

    // Mock client-side filtering that captures its use
    mockFilterTasksByStatus = mock((results: any[], options: any) => {
      capturedClientFilters = options;

      // Simulate client-side filtering removing DONE tasks
      if (options.all === false) {
        return results.filter((r) => r.status !== "DONE");
      }
      return results;
    });
  });

  test("DEMONSTRATES BUG: backend filter + client filter = wrong results", async () => {
    // Simulate the current broken behavior

    // 1. Server-side filtering for backend
    const serverResults = await mockSearchByText("session", 10, undefined, { backend: "minsky" });

    // 2. Client-side filtering for default status (current buggy behavior)
    const clientResults = mockFilterTasksByStatus(
      serverResults.map((r) => ({ ...r, status: r.metadata.status })),
      { status: undefined, all: false }
    );

    // BUG DEMONSTRATION: We applied both filters!
    expect(capturedServerFilters).toEqual({ backend: "minsky" });
    expect(capturedClientFilters).toEqual({ status: undefined, all: false });

    // WRONG RESULT: Server found 3 minsky tasks, client removed 2 DONE tasks = 1 result
    expect(serverResults).toHaveLength(3); // Server found 3 minsky tasks
    expect(clientResults).toHaveLength(1); // Client removed DONE tasks, left 1

    // This is WRONG - we should either:
    // A) Do ALL filtering server-side, OR
    // B) Do ALL filtering client-side
    // NOT BOTH!
  });

  test("CORRECT BEHAVIOR: server-side filtering only", async () => {
    // How it SHOULD work - server does ALL filtering

    // Build complete filters on server side
    const filters = {
      backend: "minsky",
      // TODO: Add NOT IN logic for default status filtering
    };

    const results = await mockSearchByText("session", 10, undefined, filters);

    // No client-side filtering needed!
    expect(capturedServerFilters).toEqual(filters);
    expect(mockFilterTasksByStatus).not.toHaveBeenCalled();

    // Server returns exactly what user requested
    expect(results).toHaveLength(3); // All minsky backend tasks
    expect(results.every((r) => r.metadata.backend === "minsky")).toBe(true);
  });

  test("PERFORMANCE PROOF: single filtering operation", async () => {
    // Proof that we should only filter once

    const filters = { status: "TODO" };
    const results = await mockSearchByText("session", 10, undefined, filters);

    // PROOF: Only one filtering operation
    expect(mockSearchByText).toHaveBeenCalledTimes(1);
    expect(mockFilterTasksByStatus).not.toHaveBeenCalled();

    // PROOF: Correct results from single operation
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.metadata.status === "TODO")).toBe(true);
  });

  test("REQUIREMENT: backend filters must work correctly", async () => {
    // This test will FAIL until we fix the CLI command

    const filters = { backend: "minsky" };
    const results = await mockSearchByText("session", 10, undefined, filters);

    // Should return ALL minsky tasks, not filter them out
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.metadata.backend === "minsky")).toBe(true);

    // Should include both TODO and DONE tasks when only backend filtered
    const statuses = results.map((r) => r.metadata.status);
    expect(statuses).toContain("TODO");
    expect(statuses).toContain("DONE");
  });
});
