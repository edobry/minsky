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
export const compat = {
  setupTestCompat: () => {
    // No-op for basic compatibility
  },
  
  createCompatMock: (implementation?: (...args: any[]) => any) => {
    const mockFn = createMock(implementation);
    
    // Add Jest-style methods
    mockFn.mockClear = () => {
      mockFn.mock.calls.length = 0;
      mockFn.mock.results.length = 0;
    };
    
    mockFn.mockReset = () => {
      mockFn.mockClear();
      mockFn.mockImplementation(() => undefined);
    };
    
    mockFn.mockImplementationOnce = (fn: (...args: any[]) => any) => {
      let used = false;
      const originalImpl = mockFn.mockImplementation;
      mockFn.mockImplementation = (...args: any[]) => {
        if (!used) {
          used = true;
          return fn(...args);
        }
        return originalImpl ? originalImpl(...args) : undefined;
      };
    };
    
    mockFn.mockReturnValueOnce = (value: any) => {
      mockFn.mockImplementationOnce(() => value);
    };
    
    return mockFn;
  },
  
  asymmetricMatchers: {
    anything: () => ({
      asymmetricMatch: (actual: any) => actual !== null && actual !== undefined,
      toString: () => "anything()"
    }),
    
    any: (constructor: any) => ({
      asymmetricMatch: (actual: any) => actual instanceof constructor,
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
        return Object.keys(obj).every(key => 
          key in actual && actual[key] === obj[key]
        );
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
  }
};
