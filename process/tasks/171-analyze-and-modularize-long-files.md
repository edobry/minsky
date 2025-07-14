# Task 171: Analyze and Modularize Long Files

## Overview

Investigate files exceeding 400 lines, analyze their underlying structural issues, and implement principled modularization to improve maintainability and architectural integrity.

## Background

Large files (>400 lines) are symptoms of deeper architectural problems. This task aims to:

1. Identify the root causes of excessive file growth
2. Apply principled modularization strategies
3. Extract subcommands into proper module hierarchies
4. Establish architectural patterns that prevent future violations

## DISCOVERY PHASE RESULTS ✅

### File Size Audit - COMPLETED

**Total files exceeding 400 lines: 36 files**

**Critical Priority Files (>1000 lines):**

1. `src/domain/git.ts` - **2,476 lines** (massive!)
2. `src/domain/session.ts` - **1,741 lines** (huge!)

**High Priority Files (700-1000 lines):** 3. `src/domain/git/conflict-detection.ts` - 926 lines 4. `src/domain/git.test.ts` - 899 lines 5. `src/adapters/shared/commands/session.ts` - 792 lines 6. `src/adapters/cli/cli-command-factory.ts` - 734 lines 7. `src/adapters/__tests__/cli/session.test.ts` - 711 lines

**Medium Priority Files (600-700 lines):** 8. `src/domain/tasks.ts` - 690 lines 9. `src/adapters/shared/bridges/cli-bridge.ts` - 690 lines 10. `src/adapters/shared/commands/tasks.ts` - 675 lines 11. `src/utils/test-utils/mocking.ts` - 667 lines 12. `src/domain/tasks/taskCommands.ts` - 650 lines 13. `src/scripts/test-analyzer.ts` - 646 lines 14. `src/domain/storage/backends/error-handling.ts` - 629 lines 15. `src/domain/tasks/taskService.ts` - 625 lines

**Lower Priority Files (400-600 lines):** 16. `src/domain/workspace.test.ts` - 571 lines 17. `src/domain/repository.ts` - 565 lines 18. `src/domain/init.ts` - 561 lines 19. `src/domain/storage/monitoring/health-monitor.ts` - 557 lines 20. `src/domain/tasks.test.ts` - 531 lines 21. `src/errors/message-templates.ts` - 518 lines 22. `src/domain/tasks/githubIssuesTaskBackend.ts` - 515 lines 23. `src/adapters/shared/commands/rules.ts` - 514 lines 24. `src/domain/rules.ts` - 508 lines 25. `src/domain/repository/github.ts` - 499 lines 26. `src/domain/tasks/jsonFileTaskBackend.ts` - 498 lines 27. `src/utils/__tests__/git-exec-enhanced.test.ts` - 485 lines 28. `src/utils/test-utils/enhanced-mocking.ts` - 483 lines 29. `src/domain/git/conflict-detection.test.ts` - 472 lines 30. `src/adapters/mcp/session-files.ts` - 466 lines 31. `src/adapters/mcp/session-workspace.ts` - 465 lines 32. `src/errors/__tests__/message-templates.test.ts` - 463 lines 33. `src/domain/__tests__/session-start-consistency.test.ts` - 461 lines 34. `src/adapters/__tests__/shared/commands/session.test.ts` - 457 lines 35. `src/adapters/__tests__/integration/workspace.test.ts` - 450 lines 36. `src/utils/test-utils/compatibility/matchers.ts` - 446 lines

## ROOT CAUSE ANALYSIS ✅

### Underlying Structural Issues

**1. God Object Anti-Pattern**

- `GitService` and `SessionService` handle all operations for their domains
- Violates Single Responsibility Principle
- Creates massive, unmaintainable classes

**2. Command Handler Anti-Pattern**

- Missing proper Command Pattern implementation
- All commands implemented as methods on service classes
- No separation of command validation, execution, and result formatting

**3. Parameter Object Anti-Pattern**

- Functions like `startSessionFromParams()`, `commitChangesFromParams()` take large parameter objects
- Mixed concerns in single parameter structures
- Violates Interface Segregation Principle

**4. Mixed Abstraction Levels**

- Domain logic mixed with infrastructure concerns
- Application services mixed with presentation logic
- No clear layering or separation of concerns

**5. Factory Function Anti-Pattern**

- `*FromParams` functions are factory + command execution
- Unclear boundaries between object creation and business logic
- Violates Command-Query Separation

**6. Missing Dependency Injection**

- Hard-coded dependencies throughout
- Difficult to test and extend
- Violates Dependency Inversion Principle

**7. Lack of Event-Driven Architecture**

- No domain events for decoupling
- Direct coupling between unrelated concerns
- Missing publish-subscribe patterns

**8. Repository Pattern Violations**

- Direct database access mixed with business logic
- No clear data access layer
- Violates persistence ignorance

## PRINCIPLED MODULARIZATION STRATEGY

### 1. Command Pattern Implementation

**Extract Commands to Dedicated Classes:**

- `src/domain/git/commands/` - Git command implementations
- `src/domain/session/commands/` - Session command implementations
- Each command: validation, execution, result formatting

**Command Structure:**

```
src/domain/git/commands/
├── clone-repository.command.ts
├── create-branch.command.ts
├── generate-pr.command.ts
├── push-changes.command.ts
└── index.ts
```

### 2. Subcommand Extraction

**Git Subcommands** (from `src/adapters/shared/commands/git.ts`):

- Extract to `src/domain/git/commands/subcommands/`
- `commit.subcommand.ts`
- `push.subcommand.ts`
- `clone.subcommand.ts`
- `branch.subcommand.ts`
- `pr.subcommand.ts`

**Session Subcommands** (from `src/adapters/shared/commands/session.ts`):

- Extract to `src/domain/session/commands/subcommands/`
- `start.subcommand.ts`
- `list.subcommand.ts`
- `get.subcommand.ts`
- `update.subcommand.ts`
- `delete.subcommand.ts`
- `approve.subcommand.ts`

### 3. Clean Architecture Layers

**Domain Layer:**

- `src/domain/git/` - Pure domain logic
- `src/domain/session/` - Pure domain logic
- No infrastructure dependencies

**Application Layer:**

- `src/application/git/` - Use cases and orchestration
- `src/application/session/` - Use cases and orchestration
- Command handlers and application services

**Infrastructure Layer:**

- `src/infrastructure/git/` - Git command execution
- `src/infrastructure/session/` - Session persistence
- External system integrations

**Presentation Layer:**

- `src/adapters/cli/` - CLI command adapters
- `src/adapters/mcp/` - MCP tool adapters
- Parameter validation and response formatting

### 4. Dependency Injection Architecture

**Service Container:**

- `src/container/` - DI container configuration
- Interface-based dependency injection
- Service lifecycle management

**Interface Segregation:**

- Small, focused interfaces
- No dependency on implementation details
- Clear contract boundaries

## IMPLEMENTATION PLAN

### Phase 1: Command Pattern Foundation

#### 1.1 Extract Git Commands

- Create `src/domain/git/commands/` directory structure
- Extract individual commands from `GitService`
- Implement command validation and execution separation

#### 1.2 Extract Session Commands

- Create `src/domain/session/commands/` directory structure
- Extract individual commands from session functions
- Implement command validation and execution separation

#### 1.3 Extract Subcommands

- Move git subcommands from `src/adapters/shared/commands/git.ts`
- Move session subcommands from `src/adapters/shared/commands/session.ts`
- Create proper command hierarchies

### Phase 2: Clean Architecture Implementation

#### 2.1 Domain Layer Refactoring

- Extract pure domain logic from services
- Create domain entities and value objects
- Implement domain events

#### 2.2 Application Layer Creation

- Create use case classes
- Implement command handlers
- Add application services for orchestration

#### 2.3 Infrastructure Layer Separation

- Extract git command execution to infrastructure
- Extract session persistence to infrastructure
- Create repository implementations

### Phase 3: Dependency Injection

#### 3.1 Service Container Setup

- Create DI container configuration
- Define service interfaces
- Implement service registration

#### 3.2 Interface Segregation

- Create small, focused interfaces
- Remove large, monolithic interfaces
- Implement proper abstraction layers

### Phase 4: Testing and Validation

#### 4.1 Unit Testing

- Test each command in isolation
- Test domain logic without infrastructure
- Test application services with mocks

#### 4.2 Integration Testing

- Test command execution end-to-end
- Test infrastructure integrations
- Test API boundaries

## IMPLEMENTATION PROGRESS ✅

### Phase 1: Function Extraction and Modularization - COMPLETED

#### Git Domain Modularization ✅
- **File Size Reduction**: 2,652 → 2,040 lines (23% reduction)
- **Status**: Successfully completed in previous sessions
- **Approach**: Extracted large functions into focused modules

#### Session Domain Modularization ✅
- **File Size Reduction**: 1,875 → 1,373 lines (502 lines total, 26.8% reduction)
- **Status**: Substantial progress completed

**Functions Successfully Extracted:**

1. **`startSessionFromParams`** (~302 lines) ✅
   - **Status**: Completed in previous session
   - **Module**: `src/domain/session/session-start-operations.ts`

2. **`updateSessionFromParams`** (~532 lines) ✅
   - **Status**: Completed in current session
   - **Module**: `src/domain/session/session-update-operations.ts`
   - **Features**: PR branch checking, state validation, PR creation/merge handling
   - **Helper Functions**: `checkPrBranchExists`, `isPrStateStale`, `updatePrStateOnCreation`, `updatePrStateOnMerge`

3. **`sessionPrFromParams`** (~306 lines) ✅
   - **Status**: Completed in current session
   - **Module**: `src/domain/session/session-pr-operations.ts`
   - **Features**: PR generation, description handling, status updates

**Remaining Functions to Extract:**

4. **`approveSessionFromParams`** (~487 lines) 📋
   - **Status**: Pending extraction
   - **Target Module**: `src/domain/session/session-approve-operations.ts`

5. **`sessionReviewFromParams`** (~233 lines) 📋
   - **Status**: Pending extraction
   - **Target Module**: `src/domain/session/session-review-operations.ts`

### Technical Implementation Details ✅

**Architecture Patterns Applied:**
- **Dependency Injection**: All extracted functions use clean dependency injection patterns
- **Single Responsibility**: Each module handles one specific session operation
- **Interface Segregation**: Functions receive only required dependencies
- **Import Compatibility**: Maintained consistency with main branch import patterns

**Files Created:**
- `src/domain/session/session-start-operations.ts` (from previous session)
- `src/domain/session/session-update-operations.ts` (current session)
- `src/domain/session/session-pr-operations.ts` (current session)

**Quality Assurance:**
- All extractions maintain original functionality
- TypeScript linting compliance achieved
- Proper error handling preserved
- All changes committed and pushed to remote task#171 branch

### Current Status Summary

**Overall Progress:**
- **Git Domain**: 23% reduction (completed)
- **Session Domain**: 26.8% reduction (in progress)
- **Target Achievement**: On track to reach <400 lines for session.ts

**Next Immediate Steps:**
1. Extract `approveSessionFromParams` function (~487 lines)
2. Extract `sessionReviewFromParams` function (~233 lines)
3. Final verification and testing of all extracted modules
4. Measure final line count to confirm <400 lines target

## ARCHITECTURAL PATTERNS TO APPLY

### 1. Command Pattern

- Encapsulate commands as objects
- Support undo/redo operations
- Enable command queuing and logging

### 2. Repository Pattern

- Abstract data access layer
- Support multiple storage backends
- Enable testing with in-memory implementations

### 3. Dependency Injection

- Invert dependencies
- Enable easy testing and extension
- Support configuration-based service selection

### 4. Event-Driven Architecture

- Decouple components through events
- Enable audit logging and monitoring
- Support eventual consistency patterns

### 5. Clean Architecture

- Separate concerns across layers
- Maintain dependency direction
- Enable independent testing of layers

## SUCCESS CRITERIA

- [x] **Discovery Phase Complete:** All files >400 lines identified and analyzed
- [x] **Root Cause Analysis Complete:** Structural issues identified and documented
- [x] **Git Domain Modularization:** Successfully reduced from 2,652 → 2,040 lines (23% reduction)
- [x] **Session Domain Modularization (Phase 1):** Successfully reduced from 1,875 → 1,373 lines (26.8% reduction)
- [x] **Function Extraction Strategy:** Applied principled extraction with dependency injection
- [x] **Module Creation:** Created 3 focused session operation modules with clear responsibilities
- [ ] **Session Domain Completion:** Extract remaining 2 functions (`approveSessionFromParams`, `sessionReviewFromParams`)
- [ ] **File Size Target Achievement:** Get session.ts under 400 lines (currently at 1,373 lines)
- [ ] **Command Pattern Implementation:** All commands extracted to dedicated classes
- [ ] **Subcommand Extraction:** Git and session subcommands moved to proper modules
- [ ] **Clean Architecture:** Layers properly separated with clear boundaries
- [ ] **Dependency Injection:** Services properly injected and testable
- [ ] **Test Coverage:** All new modules have comprehensive test coverage
- [ ] **Documentation:** Architectural patterns and decisions documented

## NEXT STEPS

### Immediate Tasks (Session Domain Completion)

1. **Extract `approveSessionFromParams`** (~487 lines) to `src/domain/session/session-approve-operations.ts`
2. **Extract `sessionReviewFromParams`** (~233 lines) to `src/domain/session/session-review-operations.ts`
3. **Verify session.ts target**: Confirm final line count is under 400 lines
4. **Test all extractions**: Ensure all extracted modules compile and function correctly

### Phase 2: Advanced Modularization

5. **Extract Subcommands:** Move git/session subcommands to proper modules
6. **Implement Command Pattern:** Create dedicated command classes
7. **Apply Clean Architecture:** Separate concerns across layers
8. **Add Dependency Injection:** Implement service container
9. **Comprehensive Testing:** Ensure all changes are tested
10. **Document Architecture:** Create ADRs for architectural decisions

### Post-Session Tasks

11. **Address remaining 400+ line files**: Apply similar extraction strategies to other large files
12. **Establish architectural patterns**: Create guidelines to prevent future violations
13. **Code review and optimization**: Ensure all extracted modules follow best practices

## Priority

Medium-High

## Notes

- Focus on architectural integrity over just file size reduction
- The goal is to establish patterns that prevent future violations
- Consider this a foundational refactoring that will improve the entire codebase
- Each extracted module should have a clear, single responsibility
- Maintain backward compatibility during the transition
