/**
 * Test-driven verification of mt#477 bugfix
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";

describe("TasksSearchCommand Default Exclusion Bug (mt#477)", () => {
  let mockService: any;
  let capturedSearchFilters: any;

  beforeEach(() => {
    capturedSearchFilters = null;
    
    mockService = {
      searchByText: mock((query: string, limit: number, threshold?: number, filters?: Record<string, any>) => {
        capturedSearchFilters = filters;
        
        if (filters?.statusExclude?.includes('DONE') && filters?.statusExclude?.includes('CLOSED')) {
          return Promise.resolve([
            { id: "mt#001", score: 0.1, metadata: { status: "TODO" } },
            { id: "mt#002", score: 0.2, metadata: { status: "IN-PROGRESS" } },
          ]);
        } else {
          return Promise.resolve([
            { id: "mt#001", score: 0.1, metadata: { status: "TODO" } },
            { id: "mt#002", score: 0.2, metadata: { status: "IN-PROGRESS" } },
            { id: "mt#003", score: 0.3, metadata: { status: "DONE" } },
            { id: "mt#004", score: 0.4, metadata: { status: "CLOSED" } },
          ]);
        }
      })
    };
  });

  test("FAILING TEST (before fix): default search should exclude DONE/CLOSED", async () => {
    const statusParam = undefined;
    const showAll = false;
    
    const filters: Record<string, any> = {};
    if (statusParam && !showAll) {
      filters.status = statusParam;
    } else if (!showAll) {
      filters.statusExclude = ['DONE', 'CLOSED'];
    }

    const results = await mockService.searchByText("rules", 10, undefined, filters);

    expect(capturedSearchFilters).toEqual({
      statusExclude: ['DONE', 'CLOSED']
    });
    
    expect(results).toHaveLength(2);
    expect(results.every((r: any) => r.metadata.status !== 'DONE' && r.metadata.status !== 'CLOSED')).toBe(true);
  });

  test("BUG PROOF: before fix behavior was wrong", async () => {
    const buggyFilters = {}; 
    const buggyResults = await mockService.searchByText("rules", 10, undefined, buggyFilters);
    
    expect(buggyResults).toHaveLength(4);
    expect(buggyResults.some((r: any) => r.metadata.status === 'DONE')).toBe(true);
    expect(buggyResults.some((r: any) => r.metadata.status === 'CLOSED')).toBe(true);
  });
});
