/**
 * Test Mocking Utilities - Import Hub
 *
 * Re-exports test mocking primitives from focused submodules.
 *
 * @module mocking
 */

// Export core mock functions and types
export { createMock } from "./core/mock-functions";
export type { MockFunction } from "./core/mock-functions";

// Export cleanup and setup utilities
export { setupTestMocksWithCleanup as setupTestMocks } from "./cleanup/test-cleanup";

// Export mock objects and specialized utilities
export { createPartialMock } from "./objects/mock-objects";

// Export filesystem mocking utilities
export { createMockFilesystem } from "./filesystem/mock-filesystem";
