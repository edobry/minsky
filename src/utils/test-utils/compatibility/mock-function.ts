/**
 * Mock Function Compatibility Layer
 *
 * This module provides Jest/Vitest compatible mock function implementations that work with Bun"s test runner.
 * It extends Bun"s mock functions with additional methods and proper tracking of calls, arguments, and results.
 */
import { mock, afterEach } from "bun:test";

/**
 * Represents the result of a mock function call.
 */
type MockResult<T> = {
  type: "return" | "throw";
  value: T | any;
};

/**
 * Tracks the state and behavior of a mock function.
 */
type MockState<TArgs extends any[] = any[], TReturn = any> = {
  /**
   * All arguments received in all calls to the mock function.
   */
  calls: TArgs[];

  /**
   * The results of all calls to the mock function.
   */
  results: MockResult<TReturn>[];

  /**
   * The instances created when the mock was used as a constructor.
   */
  instances: unknown[];

  /**
   * The order of invocations of the mock function relative to other mocks.
   */
  invocationCallOrder: number[];

  /**
   * The arguments of the last call to the mock function.
   */
  lastCall: TArgs | null;

  /**
   * The current implementation of the mock function.
   */
  implementation: ((...args: TArgs) => TReturn) | null;

  /**
   * Queue of one-time implementations to use before falling back to the default implementation.
   */
  implementationsOnce: ((...args: TArgs) => TReturn)[];

  /**
   * The original implementation of the mocked function (if created with spyOn).
   */
  originalImplementation: ((...args: TArgs) => TReturn) | null;
};

/**
 * Compatibility layer for Jest/Vitest mock functions.
 * This interface extends Bun"s mock functions with additional methods found in Jest/Vitest.
 */
export interface CompatMockFunction<TReturn = any, TArgs extends any[] = any[]> {
  /**
   * Mock function that can be called with arguments.
   */
  (...args: TArgs): TReturn;

  /**
   * Mock metadata and tracking information.
   */
  mock: {
    /**
     * All arguments received in all calls to the mock function.
     */
    calls: TArgs[];

    /**
     * The results of all calls to the mock function.
     */
    results: MockResult<TReturn>[];

    /**
     * The instances created when the mock was used as a constructor.
     */
    instances: unknown[];

    /**
     * The order of invocations of the mock function relative to other mocks.
     */
    invocationCallOrder: number[];

    /**
     * The arguments of the last call to the mock function.
     */
    lastCall: TArgs | null;
  };

  /**
   * Clears all information about mock calls.
   */
  mockClear(): CompatMockFunction<TReturn, TArgs>;

  /**
   * Resets all information about the mock and replaces the implementation with an empty function.
   */
  mockReset(): CompatMockFunction<TReturn, TArgs>;

  /**
   * Restores the original (non-mocked) implementation.
   */
  mockRestore(): CompatMockFunction<TReturn, TArgs>;

  /**
   * Sets a new implementation for the mock function.
   */
  mockImplementation(_fn: (...args: TArgs) => TReturn): CompatMockFunction<TReturn, TArgs>;

  /**
   * Sets a one-time implementation for the next call.
   */
  mockImplementationOnce(fn: (...args: TArgs) => TReturn): CompatMockFunction<TReturn, TArgs>;

  /**
   * Sets the return value for all calls to the mock function.
   */
  mockReturnValue(_value: TReturn): CompatMockFunction<TReturn, TArgs>;

  /**
   * Sets a one-time return value for the next call.
   */
  mockReturnValueOnce(_value: TReturn): CompatMockFunction<TReturn, TArgs>;

  /**
   * Sets a promise return value that resolves to the given value.
   */
  mockResolvedValue<U>(value: U): CompatMockFunction<Promise<U>, TArgs>;

  /**
   * Sets a one-time promise return value that resolves to the given value.
   */
  mockResolvedValueOnce<U>(value: U): CompatMockFunction<Promise<U>, TArgs>;

  /**
   * Sets a promise return value that rejects with the given value.
   */
  mockRejectedValue(_value: unknown): CompatMockFunction<Promise<never>, TArgs>;

  /**
   * Sets a one-time promise return value that rejects with the given value.
   */
  mockRejectedValueOnce(_value: unknown): CompatMockFunction<Promise<never>, TArgs>;
}

// Global counter for tracking invocation order
let globalInvocationCount = 0;

/**
 * Creates a mock state object for tracking mock function behavior.
 */
function createMockState<TArgs extends any[], TReturn>(): MockState<TArgs, TReturn> {
  return {
    calls: [],
    results: [],
    instances: [],
    invocationCallOrder: [],
    lastCall: null,
    implementation: null,
    implementationsOnce: [],
    originalImplementation: null,
  };
}

/**
 * Creates a compatibility mock function that wraps Bun"s mock function.
 * This adds all the Jest/Vitest compatible methods and tracking behavior.
 *
 * @param implementation Optional initial implementation
 * @returns A Jest/Vitest compatible mock function
 */
export function createCompatMock<T extends (...args: unknown[]) => any>(
  implementation?: T
): CompatMockFunction<ReturnType<T>, Parameters<T>> {
  // Create the state object for tracking
  const state = createMockState<Parameters<T>, ReturnType<T>>();

  // Set the initial implementation if provided
  if (implementation) {
    state.implementation = implementation;
  }

  // Create our implementation function
  const implementationFn = (..._args: Parameters<T>): ReturnType<T> => {
    try {
      // Track the call
      state.calls.push(_args as Parameters<T>);
      state.lastCall = args as Parameters<T>;
      state.invocationCallOrder.push(++globalInvocationCount);

      // Determine which implementation to use
      let _result: ReturnType<T>;
      if (state.implementationsOnce.length > 0) {
        // Use a one-time implementation
        const implOnce = state.implementationsOnce.shift()!;
        result = implOnce(..._args);
      } else if (state.implementation) {
        // Use the current implementation
        result = state.implementation(..._args);
      } else {
        // Default implementation returns undefined
        result = undefined as unknown as ReturnType<T>;
      }

      // Track the result
      state.results.push({
        type: "return",
        value: result,
      });

      return result;
    } catch (error) {
      // Track the error
      state.results.push({
        type: "throw",
        value: error,
      });
      throw error;
    }
  };

  // Create the Bun mock function with our implementation
  const bunMockFn = mock(implementationFn);

  // Instead of trying to modify Bun"s mock function directly (which may be read-only),
  // create a new function that delegates to it
  const _mockFn = function (..._args: Parameters<T>): ReturnType<T> {
    // Call the original function directly instead of through bunMockFn
    return implementationFn(..._args);
  } as CompatMockFunction<ReturnType<T>, Parameters<T>>;

  // Add the mock property
  mockFn.mock = {
    calls: state.calls,
    results: state.results,
    instances: state.instances,
    invocationCallOrder: state.invocationCallOrder,
    lastCall: state.lastCall,
  };

  // Add mockClear method
  mockFn.mockClear = function () {
    // Reset the state but keep implementation
    state.calls = [];
    state.results = [];
    state.instances = [];
    state.invocationCallOrder = [];
    state.lastCall = null;

    // Update the mock object
    mockFn.mock = {
      calls: state.calls,
      results: state.results,
      instances: state.instances,
      invocationCallOrder: state.invocationCallOrder,
      lastCall: state.lastCall,
    };

    return mockFn;
  };

  // Add mockReset method
  mockFn.mockReset = function () {
    // Clear all tracking data and implementation
    mockFn.mockClear();
    state.implementation = null;
    state.implementationsOnce = [];

    return mockFn;
  };

  // Add mockRestore method
  mockFn.mockRestore = function () {
    mockFn.mockReset();
    if (state.originalImplementation) {
      state.implementation = state.originalImplementation;
    }
    return mockFn;
  };

  // Add mockImplementation method
  mockFn.mockImplementation = function (fn) {
    state.implementation = fn;
    return mockFn;
  };

  // Add mockImplementationOnce method
  mockFn.mockImplementationOnce = function (fn) {
    state.implementationsOnce.push(fn);
    return mockFn;
  };

  // Add mockReturnValue method
  mockFn.mockReturnValue = function (value) {
    return mockFn.mockImplementation(() => value);
  };

  // Add mockReturnValueOnce method
  mockFn.mockReturnValueOnce = function (value) {
    return mockFn.mockImplementationOnce(() => value);
  };

  // Add mockResolvedValue method
  mockFn.mockResolvedValue = function <U>(value: U) {
    // Use a cast to suppress TypeScript errors since the return types don"t match
    return mockFn.mockImplementation(
      () => Promise.resolve(value) as unknown as ReturnType<T>
    ) as any;
  };

  // Add mockResolvedValueOnce method
  mockFn.mockResolvedValueOnce = function <U>(value: U) {
    // Use a cast to suppress TypeScript errors since the return types don"t match
    return mockFn.mockImplementationOnce(
      () => Promise.resolve(value) as unknown as ReturnType<T>
    ) as any;
  };

  // Add mockRejectedValue method
  mockFn.mockRejectedValue = function (value) {
    // Use a cast to suppress TypeScript errors since the return types don"t match
    return mockFn.mockImplementation(
      () => Promise.reject(value) as unknown as ReturnType<T>
    ) as any;
  };

  // Add mockRejectedValueOnce method
  mockFn.mockRejectedValueOnce = function (value) {
    // Use a cast to suppress TypeScript errors since the return types don"t match
    return mockFn.mockImplementationOnce(
      () => Promise.reject(value) as unknown as ReturnType<T>
    ) as any;
  };

  // If there"s an initial implementation, set it
  if (implementation) {
    mockFn.mockImplementation(implementation);
  }

  return mockFn;
}

/**
 * Creates a type-safe mock function with tracking capabilities.
 * This provides strong TypeScript typing for the mock function.
 *
 * @param implementation Optional initial implementation
 * @returns A strongly typed mock function
 */
export function createTypedMock<T extends (..._args: unknown[]) => any>(
  implementation?: T
): CompatMockFunction<ReturnType<T>, Parameters<T>> & T {
  return createCompatMock(implementation) as CompatMockFunction<ReturnType<T>, Parameters<T>> & T;
}

/**
 * Creates a spy on an object method, replacing it with a mock function.
 * Unlike Jest"s spyOn, this implementation actually replaces the method.
 *
 * @param object The object containing the method to spy on
 * @param method The name of the method to spy on
 * @returns A mock function that replaces the original method
 */
export function spyOn<T extends object, M extends keyof T>(
  object: T,
  method: M
): CompatMockFunction<any, any> {
  // Store the original method
  const original = object[method];

  // Create a mock function that wraps the original
  const _mockFn = createCompatMock((..._args: unknown[]) => {
    if (typeof original === "function") {
      return (original as Function).apply(_object, _args);
    }
    return undefined;
  });

  // Store the original implementation for restoration
  (mockFn as any).mock.originalImplementation = original;

  // Replace the method with our mock
  (object as any)[method] = mockFn;

  return mockFn;
}

/**
 * Resets all mocks to their initial state.
 * This is useful for cleaning up between tests.
 */
export function resetAllMocks(): void {
  // This delegates to Bun"s mock.restore() for now
  // In the future, we might need to track our own mocks
  mock.restore();

  // Reset the global invocation counter
  globalInvocationCount = 0;
}

/**
 * Creates an auto-mocked version of a module.
 * This recursively replaces all functions with mocks.
 *
 * @param module The module object to mock
 * @returns An auto-mocked version of the module
 */
export function autoMockModule<T extends object>(module: T): T {
  const mockedModule = { ...module } as any;

  // Recursively replace all functions with mocks
  for (const key in mockedModule) {
    if (typeof mockedModule[key] === "function") {
      mockedModule[key] = createCompatMock(mockedModule[key]);
    } else if (typeof mockedModule[key] === "object" && mockedModule[key] !== null) {
      mockedModule[key] = autoMockModule(mockedModule[key]);
    }
  }

  return mockedModule as T;
}

/**
 * Initializes the mock compatibility layer for a test file.
 * This should be called at the top of your test file, outside of any test or describe blocks.
 */
export function setupMockCompat(): void {
  // Set up automatic mock cleanup after each test
  afterEach(() => {
    resetAllMocks();
  });
}
