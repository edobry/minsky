/**
 * Tests for the mocking utilities
 */
import { describe, expect, test } from "bun:test";
import { expectToMatch } from "../assertions";
import { createMock, createSpyOn } from "../mocking";
describe("Mocking Utilities", () => {
  test("createMock creates a proper mock function", () => {
    // Create a mock
    const mockFn = createMock((arg: string) => `Hello, ${arg}!`);

    // Should work as a function
    expect((mockFn as any)("World")).toBe("Hello, World!");

    // Should track calls
    expect(mockFn.mock.calls.length).toBe(1);
    const args = mockFn.mock.calls[0] || [];
    expect(args[0]).toBe("World");
  });

  test("createMock without implementation returns a mock that returns undefined", () => {
    const mockFn = createMock();

    expect((mockFn as any)()).toBeUndefined();
    expect(mockFn.mock.calls.length).toBe(1);
  });

  test("createSpyOn spies on object methods", () => {
    // Create an object with a method
    const obj = {
      greet: (name: string) => `Hello, ${name}!`,
    };

    // Spy on the method
    const spy = createSpyOn(obj, "greet");

    // Original method should still be called
    expect(obj.greet("World")).toBe("Hello, World!");

    // Spy should record calls
    expect(spy.mock.calls.length).toBe(1);
    const args = spy.mock.calls[0] || [];
    expect(args[0]).toBe("World");
  });

  test("createSpyOn throws error when trying to spy on non-function property", () => {
    const obj = {
      name: "John",
    };

    let hasThrown = false;
    try {
      createSpyOn(obj, "name");
    } catch (e) {
      hasThrown = true;
      if (e instanceof Error) {
        expectToMatch(e.message, /Cannot spy on name because it is not a function/);
      }
    }

    expect(hasThrown).toBe(true);
  });
});
