/**
 * Custom assertion helpers to bridge Jest/Vitest and Bun test assertion differences
 *
 * This module provides helper functions that implement Jest/Vitest assertion
 * methods that are not directly available in Bun"s test framework.
 */

import { expect } from "bun:test";

/**
 * Custom matcher to replicate Jest"s toMatch functionality
 * @param value The string to test
 * @param pattern The regex pattern to match against
 */
export function expectToMatch(value: string, pattern: RegExp): void {
  const result = value.match(pattern);
  expect(result)!.toBeTruthy();
}

/**
 * Custom matcher to replicate Jest"s toHaveLength functionality
 * @param value The array or string to test
 * @param length The expected length
 */
export function expectToHaveLength(value: unknown, length: number): void {
  expect(value.length).toBe(length);
}

/**
 * Custom matcher to replicate Jest"s toBeInstanceOf functionality
 * @param value The value to test
 * @param constructor The expected constructor
 */
export function expectToBeInstanceOf(value: unknown, constructor: Function): void {
  expect(value instanceof constructor).toBeTruthy();
}

/**
 * Custom matcher to replicate Jest"s not.toBeNull functionality
 * @param value The value to test
 */
export function expectToNotBeNull(value: unknown): void {
  expect(value !== null).toBeTruthy();
}

/**
 * Custom matcher to replicate Jest"s toHaveBeenCalled functionality
 * @param mockFn The mock function to check
 */
export function expectToHaveBeenCalled(mockFn: { mock?: { calls: unknown[][] } }): void {
  expect(mockFn.mock?.calls.length).toBeGreaterThan(0);
}

/**
 * Custom matcher to replicate Jest"s toHaveBeenCalledWith functionality
 * @param mockFn The mock function to check
 * @param expectedArgs The expected arguments
 */
export function expectToHaveBeenCalledWith(
  mockFn: { mock?: { calls: unknown[][] } },
  ...expectedArgs: unknown[]
): void {
  expect(mockFn.mock?.calls.length).toBeGreaterThan(0);

  const found = mockFn.mock?.calls.some((call) => {
    if (call?.length !== expectedArgs?.length) return false;
    return call.every((arg, index) => {
      try {
        expect(arg).toEqual(expectedArgs[index]);
        return true;
      } catch (_error) {
        return false;
      }
    });
  });

  expect(found).toBeTruthy();
}

/**
 * Get a specific call argument from a mock function
 * @param mockFn The mock function
 * @param callIndex The call index (defaults to 0)
 * @param argIndex The argument index (defaults to 0)
 * @returns The argument at the specified position
 */
export function getMockCallArg(
  mockFn: { mock?: { calls: unknown[][] } },
  callIndex = 0,
  argIndex = 0
): unknown {
  return mockFn.mock?.calls[callIndex]?.[argIndex];
}

/**
 * Custom matcher to replicate Jest"s toHaveProperty functionality
 * @param object The object to test
 * @param propertyPath The path to the property (can be nested using dot notation)
 * @param value Optional expected value of the property
 */
export function expectToHaveProperty(object: unknown, propertyPath: string, value?: any): void {
  const parts = propertyPath.split(".");
  let current = object;

  for (const part of parts) {
    expect(current).toBeDefined();
    expect(typeof current === "object" || Array.isArray(current)).toBeTruthy();
    expect(part in current).toBeTruthy();
    current = current[part];
  }

  if (value !== undefined) {
    expect(current).toEqual(value);
  }
}

/**
 * Custom matcher to replicate Jest"s toBeCloseTo functionality for floating point comparison
 * @param received The actual value
 * @param expected The expected value
 * @param precision The number of decimal places to check (default: 2)
 */
export function expectToBeCloseTo(
  received: number,
  expected: number,
  precision: number = 2
): void {
  const factor = Math.pow(10, precision);
  const receivedRounded = Math.round(received * factor);
  const expectedRounded = Math.round(expected * factor);

  expect(receivedRounded).toBe(expectedRounded);
}

/**
 * Custom matcher to replicate Jest"s toContainEqual functionality
 * @param received The array to test
 * @param expected The item that should be found in the array
 */
export function expectToContainEqual(received: unknown[], expected: any): void {
  const found = received.some((item) => {
    try {
      expect(item).toEqual(expected);
      return true;
    } catch (_error) {
      return false;
    }
  });

  expect(found).toBeTruthy();
}

/**
 * Apply these custom assertion methods to a test case
 * @param testFn The test function to execute with enhanced assertions
 * @returns A wrapped test function with enhanced assertions
 */
export function withEnhancedAssertions<T extends (...args: unknown[]) => any>(testFn: T): T {
  return function (this: unknown, ...args: unknown[]) {
    // Could potentially extend expect with custom matchers here in the future
    return testFn.apply(this, args);
  };
}
