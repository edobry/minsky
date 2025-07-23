/**
 * Core Mock Functions
 * 
 * Provides basic mock creation and function mocking utilities for consistent test patterns.
 * This module contains the fundamental building blocks for all mocking operations.
 * 
 * @module core/mock-functions
 */
import { mock } from "bun:test";

// Define a MockFunction type to replace jest.Mock
export interface MockFunction<TReturn = any, TArgs extends any[] = any[]> {
  (...args: TArgs): TReturn;
  mock: {
    calls: TArgs[];
    results: Array<{
      type: "return" | "throw";
      value: TReturn | Error;
    }>;
  };
  mockImplementation: (fn: (...args: unknown[]) => TReturn) => MockFunction<TReturn, TArgs>;
  mockReturnValue: (value: unknown) => MockFunction<TReturn, TArgs>;
  mockResolvedValue: <U>(value: unknown) => MockFunction<Promise<U>, TArgs>;
  mockRejectedValue: (_reason: unknown) => MockFunction<Promise<never>, TArgs>;
}

/**
 * Creates a type-safe mock function with tracking capabilities.
 * This is a more strongly typed version of createMock.
 *
 * @template T - The function signature to mock
 * @param implementation - Optional initial implementation of the mock
 * @returns A mock function that tracks calls and can be configured with proper type inference
 *
 * @example
 * // Create a type-safe mock with implementation
 * type GreetFn = (_name: unknown) => string;
 * const mockGreet = mockFunction<GreetFn>((name) => `Hello, ${name}!`);
 * const _result = mockGreet("World"); // TypeScript knows this returns string
 */
export function mockFunction<T extends (...args: unknown[]) => any>(implementation?: T): MockFunction<ReturnType<T>, Parameters<T>> & T {
  // Cast through unknown to ensure proper type mapping
  return createMock(implementation) as MockFunction<ReturnType<T>, Parameters<T>> & T;
}

/**
 * Creates a mock function with type safety and tracking capabilities.
 * This is a wrapper around Bun's mock function with improved TypeScript support.
 *
 * @template T - The function signature to mock
 * @param implementation - Optional initial implementation of the mock
 * @returns A mock function that tracks calls and can be configured
 *
 * @example
 * // Create a basic mock
 * const mockFn = createMock();
 * mockFn("test");
 * expect(mockFn).toHaveBeenCalledWith("test");
 *
 * @example
 * // Create a mock with implementation
 * const mockGreet = createMock((_name: unknown) => `Hello, ${name}!`);
 * expect(mockGreet("World")).toBe("Hello, World!");
 * expect(mockGreet.mock.calls.length).toBe(1);
 *
 * @example
 * // Change implementation later
 * mockFn.mockImplementation(() => "new result");
 * expect(mockFn()).toBe("new result");
 */
export function createMock<T extends (...args: unknown[]) => any>(implementation?: T) {
  // Use Bun's mock directly instead of trying to access mock.fn
  return implementation ? mock(implementation) : mock(() => {});
}

/**
 * Mock a module with a factory function.
 *
 * @example
 * mockModule("./utils", () => ({ helper: vi.fn() }));
 * expect(someFunction()).toBe("mocked result");
 */
export function mockModule(_modulePath: string, factory: () => any): void {
  mock.module(_modulePath, factory); // Use mock.module for module mocking
}