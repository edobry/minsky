# Task 171: Analyze and Modularize Overly Long Files

## Overview

Investigate files exceeding 400 lines, analyze their structure and purpose, and develop strategies to break them up into smaller, more maintainable modules.

## Background

Large files (>400 lines) can become difficult to maintain, understand, and test. This task aims to:

1. Identify files that exceed the 400-line guideline
2. Analyze why these files are large and their internal structure
3. Develop modularization strategies
4. Implement refactoring to improve code organization

## DISCOVERY PHASE RESULTS ✅

### File Size Audit - COMPLETED

**Total files exceeding 400 lines: 36 files**

**Critical Priority Files (>1000 lines):**

1. `src/domain/git.ts` - **2,476 lines** (massive!)
2. `src/domain/session.ts` - **1,741 lines** (huge!)

**High Priority Files (700-1000 lines):** 3. `src/domain/git/conflict-detection.ts` - 926 lines 4. `src/domain/git.test.ts` - 899 lines 5. `src/adapters/shared/commands/session.ts` - 792 lines 6. `src/adapters/cli/cli-command-factory.ts` - 734 lines 7. `src/adapters/__tests__/cli/session.test.ts` - 711 lines

**Medium Priority Files (600-700 lines):** 8. `src/domain/tasks.ts` - 690 lines 9. `src/adapters/shared/bridges/cli-bridge.ts` - 690 lines 10. `src/adapters/shared/commands/tasks.ts` - 675 lines 11. `src/utils/test-utils/mocking.ts` - 667 lines 12. `src/domain/tasks/taskCommands.ts` - 650 lines 13. `src/scripts/test-analyzer.ts` - 646 lines 14. `src/domain/storage/backends/error-handling.ts` - 629 lines 15. `src/domain/tasks/taskService.ts` - 625 lines

**Lower Priority Files (400-600 lines):** 16. `src/domain/workspace.test.ts` - 571 lines 17. `src/domain/repository.ts` - 565 lines 18. `src/domain/init.ts` - 561 lines 19. `src/domain/storage/monitoring/health-monitor.ts` - 557 lines 20. `src/domain/tasks.test.ts` - 531 lines 21. `src/errors/message-templates.ts` - 518 lines 22. `src/domain/tasks/githubIssuesTaskBackend.ts` - 515 lines 23. `src/adapters/shared/commands/rules.ts` - 514 lines 24. `src/domain/rules.ts` - 508 lines 25. `src/domain/repository/github.ts` - 499 lines 26. `src/domain/tasks/jsonFileTaskBackend.ts` - 498 lines 27. `src/utils/__tests__/git-exec-enhanced.test.ts` - 485 lines 28. `src/utils/test-utils/enhanced-mocking.ts` - 483 lines 29. `src/domain/git/conflict-detection.test.ts` - 472 lines 30. `src/adapters/mcp/session-files.ts` - 466 lines 31. `src/adapters/mcp/session-workspace.ts` - 465 lines 32. `src/errors/__tests__/message-templates.test.ts` - 463 lines 33. `src/domain/__tests__/session-start-consistency.test.ts` - 461 lines 34. `src/adapters/__tests__/shared/commands/session.test.ts` - 457 lines 35. `src/adapters/__tests__/integration/workspace.test.ts` - 450 lines 36. `src/utils/test-utils/compatibility/matchers.ts` - 446 lines

### Structural Analysis - COMPLETED

#### 1. `src/domain/git.ts` (2,476 lines) - ANALYZED

**Structure:**

- **Interfaces & Types (lines 1-296):** 30+ interfaces defining service contracts
- **GitService Class (lines 297-2247):** Main service implementation with 50+ methods
- **Factory Functions (lines 2248-2477):** Wrapper functions for external API

**Primary Responsibilities:**

- Git repository operations (clone, branch, merge, push)
- PR creation and management
- Conflict detection integration
- Session-based workflow management

**Modularization Opportunities:**

- **Extract Git Types:** Move all interfaces to `src/domain/git/types.ts`
- **Extract PR Service:** Move PR-related functionality to `src/domain/git/pr-service.ts`
- **Extract Basic Git Operations:** Move core git ops to `src/domain/git/basic-operations.ts`
- **Extract Session Git Operations:** Move session-specific git ops to `src/domain/git/session-operations.ts`
- **Extract Factory Functions:** Move to `src/domain/git/factory.ts`

#### 2. `src/domain/session.ts` (1,741 lines) - ANALYZED

**Structure:**

- **Interfaces (lines 1-100):** SessionRecord, Session, SessionProviderInterface
- **Core Functions (lines 101-1450):** Various session operation functions
- **Provider Factory (lines 1451-1500):** Session provider creation
- **Review Functions (lines 1501-1742):** Session review and inspection

**Primary Responsibilities:**

- Session lifecycle management
- Session database operations
- Session-based workspace management
- PR and approval workflows

**Modularization Opportunities:**

- **Extract Session Types:** Move interfaces to `src/domain/session/types.ts`
- **Extract Session Provider:** Move provider logic to `src/domain/session/provider.ts`
- **Extract Session Operations:** Move core ops to `src/domain/session/operations.ts`
- **Extract Session Review:** Move review functionality to `src/domain/session/review.ts`
- **Extract Session Factory:** Move factory functions to `src/domain/session/factory.ts`

#### 3. `src/domain/git/conflict-detection.ts` (926 lines) - ANALYZED

**Structure:**

- **Interfaces (lines 1-100):** ConflictPrediction, ConflictFile, etc.
- **ConflictDetectionService Class (lines 101-926):** Main service implementation
- **Private Methods:** Simulation, analysis, and resolution generation

**Primary Responsibilities:**

- Merge conflict prediction
- Branch divergence analysis
- Conflict resolution strategies
- Smart merge operations

**Modularization Opportunities:**

- **Extract Conflict Types:** Move interfaces to `src/domain/git/conflict-types.ts`
- **Extract Conflict Analysis:** Move analysis methods to `src/domain/git/conflict-analyzer.ts`
- **Extract Resolution Strategies:** Move to `src/domain/git/resolution-strategies.ts`

## IMPLEMENTATION PLAN

### Phase 1: Critical Priority Files (Week 1)

#### 1.1 Modularize `src/domain/git.ts` (2,476 lines → target: <400 lines)

**Step 1: Extract Types**

- Create `src/domain/git/types.ts` with all interfaces
- Update imports across codebase

**Step 2: Extract PR Service**

- Create `src/domain/git/pr-service.ts` with PR-related methods
- Move: `pr()`, `prWithDependencies()`, `preparePr()`, `mergePr()`, and helpers

**Step 3: Extract Basic Git Operations**

- Create `src/domain/git/basic-operations.ts`
- Move: `clone()`, `branch()`, `stash()`, `pull()`, `push()`, `commit()`, `getStatus()`

**Step 4: Extract Session Git Operations**

- Create `src/domain/git/session-operations.ts`
- Move: `branchWithoutSession()`, session-specific helpers

**Step 5: Extract Factory Functions**

- Create `src/domain/git/factory.ts`
- Move: `createPullRequestFromParams()`, `commitChangesFromParams()`, etc.

**Step 6: Create Main Service Orchestrator**

- Slim down main `git.ts` to <400 lines
- Keep only GitService class with delegation to other services

#### 1.2 Modularize `src/domain/session.ts` (1,741 lines → target: <400 lines)

**Step 1: Extract Types**

- Create `src/domain/session/types.ts` with all interfaces

**Step 2: Extract Provider**

- Create `src/domain/session/provider.ts` with SessionProviderInterface implementation

**Step 3: Extract Core Operations**

- Create `src/domain/session/operations.ts`
- Move: `startSessionFromParams()`, `getSessionFromParams()`, `listSessionsFromParams()`

**Step 4: Extract Review Operations**

- Create `src/domain/session/review.ts`
- Move: `sessionReviewFromParams()`, `inspectSessionFromParams()`

**Step 5: Extract Factory Functions**

- Create `src/domain/session/factory.ts`
- Move: `createSessionProvider()`, other factory functions

### Phase 2: High Priority Files (Week 2)

#### 2.1 Modularize `src/domain/git/conflict-detection.ts` (926 lines → target: <400 lines)

**Step 1: Extract Types**

- Create `src/domain/git/conflict-types.ts`

**Step 2: Extract Analysis Logic**

- Create `src/domain/git/conflict-analyzer.ts`
- Move: `simulateMerge()`, `analyzeConflictFiles()`, `analyzeBranchDivergence()`

**Step 3: Extract Resolution Strategies**

- Create `src/domain/git/resolution-strategies.ts`
- Move: `generateResolutionStrategies()`, `generateUserGuidance()`, `generateRecoveryCommands()`

#### 2.2 Modularize Other High Priority Files

- `src/adapters/shared/commands/session.ts` (792 lines)
- `src/adapters/cli/cli-command-factory.ts` (734 lines)

### Phase 3: Medium Priority Files (Week 3)

#### 3.1 Modularize Domain Files

- `src/domain/tasks.ts` (690 lines)
- `src/domain/tasks/taskCommands.ts` (650 lines)
- `src/domain/tasks/taskService.ts` (625 lines)

#### 3.2 Modularize Adapter Files

- `src/adapters/shared/bridges/cli-bridge.ts` (690 lines)
- `src/adapters/shared/commands/tasks.ts` (675 lines)

### Phase 4: Testing and Validation

#### 4.1 Test Suite Updates

- Update all tests to use new module structure
- Ensure no functional regressions
- Validate import/export correctness

#### 4.2 Documentation Updates

- Update module documentation
- Create architectural decision records
- Update code organization guidelines

## MODULARIZATION STRATEGY

### 1. Domain-Oriented Modules

- Group by business capability (git, session, tasks)
- Separate types, operations, and services
- Maintain clear boundaries between domains

### 2. Layer Separation

- **Types:** Interface definitions and data structures
- **Operations:** Pure functions and business logic
- **Services:** Stateful classes and orchestration
- **Factories:** Creation and configuration logic

### 3. Dependency Direction

- Types ← Operations ← Services ← Factories
- No circular dependencies
- Clear import hierarchy

### 4. File Size Targets

- **Types files:** <200 lines
- **Operation files:** <400 lines
- **Service files:** <400 lines
- **Factory files:** <300 lines

## SUCCESS CRITERIA

- [x] **Discovery Phase Complete:** All files >400 lines identified and analyzed
- [ ] **Phase 1 Complete:** git.ts and session.ts modularized (<400 lines each)
- [ ] **Phase 2 Complete:** High priority files modularized
- [ ] **Phase 3 Complete:** Medium priority files modularized
- [ ] **All Tests Pass:** No functional regressions
- [ ] **Documentation Updated:** Module structure documented
- [ ] **Target Achievement:** No files >400 lines (with documented exceptions)

## NEXT STEPS

1. **Begin Phase 1:** Start with git.ts modularization
2. **Create branches:** Use feature branches for each major file
3. **Incremental testing:** Test each module extraction
4. **Update imports:** Systematically update all references
5. **Document changes:** Record architectural decisions

## Priority

Medium-High

## Estimated Effort

**Original:** 6-10 hours
**Revised:** 12-16 hours (due to complexity discovered)

## Notes

- The scope is larger than originally anticipated - 36 files exceed 400 lines
- Two files (git.ts and session.ts) are extremely large and will require careful planning
- Focus on maintaining existing functionality while improving structure
- Consider creating a "before and after" comparison for major refactors
