/**
 * Module Mocking Compatibility Layer
 *
 * This module provides Jest/Vitest compatible module mocking utilities that work with Bun's test runner.
 * It extends Bun's mock.module with automatic module detection and improved typing.
 */
import { mock, afterEach } from "bun:test";
import { createCompatMock } from "./mock-function";
import { log } from "../../logger";

// Store original modules for restoration
const originalModules = new Map<string, any>();

// Store mocked modules for tracking
const mockedModules = new Map<string, any>();

/**
 * Options for mocking a module
 */
export interface MockModuleOptions {
  /**
   * Whether to auto-mock functions in the module
   */
  autoMock?: boolean;

  /**
   * Whether to use the actual implementations for non-mocked properties
   */
  useActual?: boolean;

  /**
   * Whether to create virtual mocks for all non-function properties
   */
  virtual?: boolean;
}

/**
 * Default options for mockModule
 */
const defaultOptions: MockModuleOptions = {
  autoMock: false,
  useActual: true,
  virtual: false,
};

/**
 * Creates an automatic mock of a module's exports
 *
 * @param modulePath The module path to mock
 * @param actualModule The actual module to base mocks on
 * @returns A mocked version of the module
 */
function createAutoMock(_modulePath: string, actualModule: any): unknown {
  const mockExports: Record<string, unknown> = {};

  // Create a mock for each export
  for (const key in actualModule) {
    if (Object.prototype.hasOwnProperty.call(actualModule, key)) {
      const value = actualModule[key];

      if (typeof value === "function") {
        // Mock functions
        mockExports[key] = createCompatMock(value);
      } else if (typeof value === "object" && value !== null) {
        // Recursively mock nested objects
        mockExports[key] = createAutoMock(`${modulePath}.${key}`, value);
      } else {
        // Copy primitive values
        mockExports[key] = value;
      }
    }
  }

  return mockExports;
}

/**
 * Mocks a module with the provided factory or auto-mocking
 *
 * @param modulePath The path to the module to mock
 * @param factory A function that returns the mocked module
 * @param options Options for how to mock the module
 */
export function mockModule(
  modulePath: string,
  factory?: () => any,
  options?: MockModuleOptions
): void {
  const mockOptions = { ...defaultOptions, ...options };

  try {
    // Store the original module if we haven't already
    if (!originalModules.has(modulePath)) {
      try {
        // Use a dynamic import to get the actual module
        // This won't work with ESM in some environments, but is needed for proper Jest-like behavior
         
        const originalModule = require(modulePath);
        originalModules.set(modulePath, originalModule);
      } catch {
        // If we can't load the module, just store undefined
        originalModules.set(modulePath, undefined);
      }
    }

    // If a factory was provided, use it to create the mock
    if (factory) {
      // For Bun v1.2.13, we need to use the right mock API pattern
      const mockImpl = factory();
      // Need to use a different approach since Bun's mock() doesn't support module mocking directly
      // For now, we'll just store the mock implementation and handle it in imports
      mockedModules.set(modulePath, mockImpl);
      return;
    }

    // If no factory was provided and autoMock is enabled, create an automatic mock
    if (mockOptions.autoMock) {
      const originalModule = originalModules.get(modulePath);
      if (originalModule) {
        const autoMocked = createAutoMock(modulePath, originalModule);
        // Store the auto-mocked module
        mockedModules.set(modulePath, autoMocked);
        return;
      }
    }

    // Default fallback: mock with an empty object
    const emptyMock = {};
    mockedModules.set(modulePath, emptyMock);
  } catch {
    log.error(`Error mocking module ${modulePath}:`, error);
    throw error;
  }
}

/**
 * Restores the original implementation of a mocked module
 *
 * @param modulePath The path to the module to restore
 */
export function restoreModule(_modulePath: string): void {
  // Remove the mock and allow the original module to be loaded again
  mock.restore();

  // Remove from our tracking maps
  mockedModules.delete(modulePath);
}

/**
 * Restores all mocked modules to their original implementations
 */
export function restoreAllModules(): void {
  // Use mock.restore() to remove all mocks
  mock.restore();

  // Clear our tracking maps
  mockedModules.clear();
}

/**
 * Gets the mock instance for a module
 *
 * @param modulePath The path to the mocked module
 * @returns The mock implementation of the module or undefined if not mocked
 */
export function getMockModule(_modulePath: string): unknown {
  return mockedModules.get(modulePath);
}

/**
 * Mocks a specific function in a module
 *
 * @param modulePath The path to the module containing the function
 * @param exportName The name of the exported function to mock
 * @param mockImplementation The mock implementation of the function
 */
export function mockModuleFunction(
  modulePath: string,
  exportName: string,
  mockImplementation: (..._args: unknown[]) => any
): void {
  // Get the original module if we have it
  const originalModule = originalModules.get(modulePath);

  // Create a factory that returns a module with the specified function mocked
  mockModule(modulePath, () => {
    const mockModule = originalModule ? { ...originalModule } : {};
    mockModule[exportName] = createCompatMock(mockImplementation);
    return mockModule;
  });
}

/**
 * Creates a Jest-like jest.mock implementation
 */
export function createJestMock() {
  return function jestMock(
    modulePath: string,
    factory?: () => any,
    options?: MockModuleOptions
  ): void {
    mockModule(modulePath, factory, _options);
  };
}

/**
 * Sets up the module mocking compatibility layer
 */
export function setupModuleMocking(): void {
  // Register cleanup with afterEach if available
  afterEach(() => {
    restoreAllModules();
  });
}

/**
 * Creates a compatibility layer that provides Jest-like module mocking
 */
export function createJestModuleMocking() {
  return {
    /**
     * Mocks a module with the provided factory
     */
    mock: createJestMock(),

    /**
     * Restores a mocked module to its original implementation
     */
    unmock: restoreModule,

    /**
     * Restores all mocked modules
     */
    resetModules: restoreAllModules,

    /**
     * Gets the mock instance for a module
     */
    getMockFromModule: getMockModule,
  };
}
