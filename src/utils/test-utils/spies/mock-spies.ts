/**
 * Mock Spies and Property Utilities
 * 
 * Provides utilities for creating spies and mocking properties for advanced testing scenarios.
 * This module includes spy creation, readonly property mocking, and method tracking.
 * 
 * @module spies/mock-spies
 */
import { mock } from "bun:test";

/**
 * Mocks a readonly property on an object.
 * This is useful for testing code that uses getters or Object.defineProperty.
 *
 * @param obj - The object containing the property to mock
 * @param propName - The name of the property to mock
 * @param mockValue - The mock value to return when the property is accessed
 *
 * @example
 * // Mock a readonly property
 * const config = {
 *   get environment() { return "production"; }
 * };
 *
 * // Mock the property
 * mockReadonlyProperty(config, "environment", "test");
 *
 * // Now accessing the property returns the mock value
 * expect(config.environment).toBe("test");
 */
export function mockReadonlyProperty<T extends object, K extends keyof T>(
  obj: T,
  propName: K,
  mockValue: any
): void {
  // Use Object.defineProperty to override the property
  Object.defineProperty(obj, propName, {
    configurable: true,
    get: () => mockValue,
  });
}

/**
 * Creates a spy on an object method.
 * Similar to Jest's spyOn, but using Bun's mock functionality.
 *
 * @template T - The object type
 * @template M - The method key type
 * @param obj - The object containing the method to spy on
 * @param method - The method name to spy on
 * @returns A mock function that can track calls to the original method
 *
 * @example
 * // Spy on a method
 * const user = { getName: () => "John" };
 * const spy = createSpyOn(user, "getName");
 * user.getName(); // Original method is called
 * expect(spy).toHaveBeenCalled();
 */
export function createSpyOn<T extends object, M extends keyof T>(
  obj: T,
  method: M
): ReturnType<typeof mock> {
  const original = obj[method];

  if (typeof original !== "function") {
    throw new Error(`Cannot spy on ${String(method)} because it is not a function`);
  }

  // Create a mock function that calls the original
  const mockFn = mock((...args: unknown[]) => {
    return (original as Function).apply(obj, args);
  });

  // Replace the original method with our mock
  // @ts-expect-error - We've already verified this is a function
  obj[method] = mockFn;

  // Return the mock function for assertions
  return mockFn;
}

/**
 * Creates a spy on an object method.
 * This is a wrapper around createSpyOn for Jest-like compatibility.
 */
export const spyOn = createSpyOn;