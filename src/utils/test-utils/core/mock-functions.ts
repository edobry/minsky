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
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic defaults use any for function type erasure boundaries; changing to unknown cascades errors in callers
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- return type any in constraint is load-bearing; unknown causes callers to lose the return type of the mocked function
export function mockFunction<T extends (...args: unknown[]) => any>(
  implementation?: T
): MockFunction<ReturnType<T>, Parameters<T>> & T {
  // Cast through unknown to ensure proper type mapping
  // eslint-disable-next-line custom/no-excessive-as-unknown -- intersection type MockFunction<R,P> & T cannot be expressed without cast; this is the canonical mock-function bridge
  return createMock(implementation) as unknown as MockFunction<ReturnType<T>, Parameters<T>> & T;
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- return type any in constraint is load-bearing; unknown causes callers to lose the return type of the wrapped function
export function createMock<T extends (...args: unknown[]) => any>(implementation?: T) {
  // Use Bun's mock directly instead of trying to access mock.fn
  return implementation ? mock(implementation) : mock(() => {});
}
