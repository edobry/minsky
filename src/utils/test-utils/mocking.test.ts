/**
 * Tests for the mocking utilities
 */
import { describe, expect, test } from "bun:test";
import { createMock } from "./mocking";
describe("Mocking Utilities", () => {
  test("createMock creates a proper mock function", () => {
    // Create a mock
    const mockFn = createMock((arg: unknown) => `Hello, ${arg}!`);

    // Should work as a function
    expect(mockFn("World")).toBe("Hello, World!");

    // Should track calls
    expect(mockFn.mock.calls.length).toBe(1);
    const args = mockFn.mock.calls[0] || [];
    expect(args[0]).toBe("World");
  });

  test("createMock without implementation returns a mock that returns undefined", () => {
    const mockFn = createMock();

    expect(mockFn()).toBeUndefined();
    expect(mockFn.mock.calls.length).toBe(1);
  });
});
