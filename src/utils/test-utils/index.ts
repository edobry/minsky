/**
 * Enhanced Test Utilities for Improved Test Isolation and Reliability
 * 
 * This module provides comprehensive testing utilities including:
 * - Enhanced cleanup management
 * - Advanced mock filesystem and module mocking
 * - Test data isolation and factories
 * - Cross-test contamination prevention
 * 
 * @module test-utils
 */

// Core cleanup utilities
export {
  TestCleanupManager,
  setupTestCleanup,
  createCleanTempDir,
  createCleanTempFile,
  cleanupLeftoverTestFiles,
  cleanupManager
} from "./cleanup";

// Enhanced mocking system
export {
  EnhancedMockFileSystem,
  EnhancedModuleMocker,
  createEnhancedMockFileSystem,
  setupEnhancedMocking,
  validateMockIsolation
} from "./enhanced-mocking";

// Test isolation and data factories
export {
  TestDataFactory,
  DatabaseIsolation,
  testDataFactory
} from "./test-isolation";

// Original utilities (avoid conflicts)
export { createMockFileSystem, setupTestMocks } from "./mocking";

// Import the functions for use in setupCompleteTestEnvironment
import { setupTestCleanup } from "./cleanup";
import { setupEnhancedMocking, validateMockIsolation } from "./enhanced-mocking";
import { testDataFactory } from "./test-isolation";
import { createMock } from "./mocking";

/**
 * Complete test environment setup with all enhanced utilities
 */
export function setupCompleteTestEnvironment() {
  const cleanup = setupTestCleanup();
  const mocking = setupEnhancedMocking();
  
  return {
    cleanup,
    mocking,
    testDataFactory,
    validateIsolation: () => {
      const mockIsolation = validateMockIsolation();
      const cleanupStats = cleanup.getCleanupStats();
      
      return {
        isIsolated: mockIsolation.isIsolated && cleanupStats.itemCount === 0,
        issues: [
          ...mockIsolation.issues,
          ...(cleanupStats.itemCount > 0 ? [`${cleanupStats.itemCount} cleanup items remaining`] : [])
        ],
        stats: {
          ...mockIsolation,
          cleanup: cleanupStats
        }
      };
    }
  };
}

/**
 * Jest/Vitest compatibility layer for Bun
 */
// Simple module registry for tracking mocked modules
const mockModuleRegistry = new Map<string, any>();

export const compat = {
  setupTestCompat: () => {
    // No-op for basic compatibility
  },
  
  createCompatMock: (implementation?: (...args: any[]) => any) => {
    const mockFn = createMock(implementation);
    
    // Store the original implementation for "once" functionality
    let originalImplementation = implementation;
    
    // Create a wrapper function that behaves like the mock but has our methods
    const compatMock = ((...args: any[]) => mockFn(...args)) as unknown;
    
    // Copy mock properties and bind methods to original mock
    compatMock.mock = mockFn.mock;
    compatMock.mockImplementation = (newImpl: (...args: any[]) => any) => {
      originalImplementation = newImpl;
      return mockFn.mockImplementation(newImpl);
    };
    compatMock.mockReturnValue = mockFn.mockReturnValue.bind(mockFn);
    compatMock.mockResolvedValue = mockFn.mockResolvedValue.bind(mockFn);
    compatMock.mockRejectedValue = mockFn.mockRejectedValue.bind(mockFn);
    
    // Add Jest-style methods
    compatMock.mockClear = () => {
      mockFn.mock.calls.length = 0;
      mockFn.mock.results.length = 0;
      return compatMock;
    };
    
    compatMock.mockReset = () => {
      mockFn.mock.calls.length = 0;
      mockFn.mock.results.length = 0;
      originalImplementation = undefined;
      mockFn.mockImplementation(() => undefined);
      return compatMock;
    };
    
    compatMock.mockImplementationOnce = (fn: (...args: any[]) => any) => {
      let used = false;
      
      // Create a wrapper that uses the once function, then reverts
      const onceWrapper = (...args: any[]) => {
        if (!used) {
          used = true;
          return fn(...args);
        }
        // Revert to original behavior after first use
        return originalImplementation ? originalImplementation(...args) : undefined;
      };
      
      mockFn.mockImplementation(onceWrapper);
      return compatMock;
    };
    
    compatMock.mockReturnValueOnce = (value: any) => {
      return compatMock.mockImplementationOnce(() => value);
    };
    
    return compatMock;
  },
  
  asymmetricMatchers: {
    anything: () => ({
      asymmetricMatch: (actual: any) => actual !== null && actual !== undefined,
      toString: () => "anything()"
    }),
    
    any: (constructor: any) => ({
      asymmetricMatch: (actual: any) => {
        if (constructor === String) return typeof actual === "string";
        if (constructor === Number) return typeof actual === "number";
        if (constructor === Boolean) return typeof actual === "boolean";
        if (constructor === Object) return typeof actual === "object" && actual !== null;
        if (constructor === Array) return Array.isArray(actual);
        return actual instanceof constructor;
      },
      toString: () => `any(${constructor.name})`
    }),
    
    stringContaining: (substring: string) => ({
      asymmetricMatch: (actual: any) => 
        typeof actual === "string" && actual.includes(substring),
      toString: () => `stringContaining(${substring})`
    }),
    
    objectContaining: (obj: any) => ({
      asymmetricMatch: (actual: any) => {
        if (typeof actual !== "object" || actual === null) return false;
        return Object.keys(obj).every(key => {
          if (!(key in actual)) return false;
          const expectedValue = obj[key];
          const actualValue = actual[key];
          
          // Handle nested asymmetric matchers
          if (expectedValue && typeof expectedValue === "object" && expectedValue.asymmetricMatch) {
            return expectedValue.asymmetricMatch(actualValue);
          }
          
          return actualValue === expectedValue;
        });
      },
      toString: () => `objectContaining(${JSON.stringify(obj)})`
    }),
    
    arrayContaining: (arr: any[]) => ({
      asymmetricMatch: (actual: any) => {
        if (!Array.isArray(actual)) return false;
        return arr.every(item => actual.includes(item));
      },
      toString: () => `arrayContaining(${JSON.stringify(arr)})`
    })
  },
  
  // Jest-style module mocking
  jest: {
    mock: (modulePath: string, factory: () => any) => {
      const mockedModule = factory();
      mockModuleRegistry.set(modulePath, mockedModule);
      return mockedModule;
    }
  },
  
  // Mock a specific function in a module
  mockModuleFunction: (modulePath: string, functionName: string, implementation: (...args: any[]) => any) => {
    let module = mockModuleRegistry.get(modulePath) || {};
    module[functionName] = implementation;
    mockModuleRegistry.set(modulePath, module);
    return implementation;
  },
  
  // Mock an entire module
  mockModule: (modulePath: string, factory: () => any) => {
    const mockedModule = factory();
    mockModuleRegistry.set(modulePath, mockedModule);
    return mockedModule;
  },
  
  // Get a mocked module (for compatibility)
  getMockModule: (modulePath: string) => {
    return mockModuleRegistry.get(modulePath) || {};
  }
};
