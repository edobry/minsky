/**
 * Test Utilities for Improved Test Isolation and Reliability
 *
 * This module provides comprehensive testing utilities including:
 * - Enhanced cleanup management
 * - Test data isolation and factories
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
  type MockSessionProviderOptions,
  type MockGitServiceOptions,
  type MockGitServiceWithCallCount,
} from "./dependencies";

// Original utilities (avoid conflicts)
export { createMockFileSystem, setupTestMocks } from "./mocking";
