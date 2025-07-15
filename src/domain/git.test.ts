/**
 * Git Test Hub - Import Hub Pattern
 * @migrated Converted to import hub after extracting tests to focused modules
 * @architecture Follows the established session test modularization pattern
 */

// Import all git test modules to ensure they run as part of the git test suite
import "./git/factory-function.test";
import "./git/architecture-analysis.test";
import "./git/session-workdir.test";
import "./git/git-service-core.test";
import "./git/parameter-based-functions.test";
import "./git/clone-operations.test";
import "./git/repository-operations.test";
import "./git/push-operations.test";
import "./git/pr-workflow.test";
import "./git/commit-operations.test";

// Note: This file now serves as an import hub for all git-related tests.
// Individual test categories have been extracted to focused modules:
// - Factory function tests: git/factory-function.test.ts
// - Architecture analysis: git/architecture-analysis.test.ts  
// - Session workdir tests: git/session-workdir.test.ts
// - Core GitService API: git/git-service-core.test.ts
// - Parameter-based functions: git/parameter-based-functions.test.ts
// - Clone operations: git/clone-operations.test.ts
// - Repository operations: git/repository-operations.test.ts
// - Push operations: git/push-operations.test.ts
// - PR workflow: git/pr-workflow.test.ts
// - Commit operations: git/commit-operations.test.ts

const TEST_VALUE = 123; // Preserved for compatibility
