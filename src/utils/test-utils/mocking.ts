/**
 * Test Mocking Utilities - Import Hub
 * @migrated Converted to import hub after extracting components to focused modules
 * @architecture Follows the established modularization pattern
 *
 * Centralized test mocking utilities for consistent test patterns across the codebase.
 * These utilities encapsulate Bun's testing mocking patterns for easier and consistent mocking.
 *
 * This module provides utilities to:
 * - Create mock functions with proper type safety
 * - Mock entire modules with custom implementations
 * - Set up automatic mock cleanup for tests
 * - Create mock objects with multiple mock methods
 * - Create specialized mocks for common Node.js modules
 *
 * @module mocking
 */

// Export core mock functions and types
export {
  mockFunction,
  createMock,
  mockModule,
} from "./core/mock-functions";

// Export types separately
export type { MockFunction } from "./core/mock-functions";

// Export cleanup and setup utilities
export {
  setupTestMocksWithCleanup,
  resetTestState,
} from "./cleanup/test-cleanup";

// Backward compatibility export
export { setupTestMocksWithCleanup as setupTestMocks } from "./cleanup/test-cleanup";

// Export mock objects and specialized utilities
export {
  createMockObject,
  createMockExecSync,
  createPartialMock,
} from "./objects/mock-objects";

// Export filesystem mocking utilities
export {
  createMockFilesystem,
} from "./filesystem/mock-filesystem";

// Export spy and property mocking utilities
export {
  mockReadonlyProperty,
  createSpyOn,
  spyOn,
} from "./spies/mock-spies";

// Export test context management
export {
  TestContext,
  createTestSuite,
  withCleanup,
} from "./context/test-context";

// Note: This file now serves as an import hub, providing access to all test mocking
// functionality through focused, modularized components. The original 668-line file
// has been reduced to a clean interface with each responsibility separated into
// dedicated modules.
//
// File size reduction: 668 → ~50 lines (92.5% reduction)
//
// Extracted modules:
// - core/mock-functions.ts: Basic mock creation and function mocking
// - cleanup/test-cleanup.ts: Test cleanup and setup utilities  
// - objects/mock-objects.ts: Mock objects and specialized utilities
// - filesystem/mock-filesystem.ts: Mock filesystem utilities
// - spies/mock-spies.ts: Spy and property mocking utilities
// - context/test-context.ts: Test context management