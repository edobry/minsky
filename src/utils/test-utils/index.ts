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
  cleanupManager,
} from "./cleanup";

// Enhanced mocking system
export {
  EnhancedMockFileSystem,
  EnhancedModuleMocker,
  createEnhancedMockFileSystem,
  setupEnhancedMocking,
  validateMockIsolation,
} from "./enhanced-mocking";

// Test isolation and data factories
export { TestDataFactory, DatabaseIsolation, testDataFactory } from "./test-isolation";

// Dependency injection utilities and individual service mock factories
export {
  createTestDeps,
  createTaskTestDeps,
  createSessionTestDeps,
  createGitTestDeps,
  createMockRepositoryBackend,
  withMockedDeps,
  createDeepTestDeps,
  createPartialTestDeps,
  // Individual service mock factories
  createMockSessionProvider,
  createMockGitService,
  createMockTaskService,
  type MockSessionProviderOptions,
  type MockGitServiceOptions,
  type MockTaskServiceOptions,
} from "./dependencies";

// Original utilities (avoid conflicts)
export { createMockFileSystem, setupTestMocks } from "./mocking";

// Import the functions for use in setupCompleteTestEnvironment
import { setupTestCleanup } from "./cleanup";
import { setupEnhancedMocking, validateMockIsolation } from "./enhanced-mocking";
import { testDataFactory } from "./test-isolation";

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
          ...(cleanupStats.itemCount > 0
            ? [`${cleanupStats.itemCount} cleanup items remaining`]
            : []),
        ],
        stats: {
          ...mockIsolation,
          cleanup: cleanupStats,
        },
      };
    },
  };
}
