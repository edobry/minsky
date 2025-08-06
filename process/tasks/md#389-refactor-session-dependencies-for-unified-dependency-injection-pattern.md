# Refactor session dependencies for unified dependency injection pattern

## Context

Currently session operations have inconsistent dependency injection patterns, leading to code duplication and maintenance challenges. Create a unified approach for session dependency management.

## Problem
Session operations (`approve`, `merge`, `review`, `start`, `pr`) each implement their own dependency injection patterns:

**Current Issues:**
- Duplicated dependency setup code across operations
- Inconsistent parameter naming and interfaces
- Mixed patterns for service creation vs injection
- Different fallback behaviors when dependencies not provided
- Hard to test due to varying mock requirements

**Example Inconsistencies:**
```typescript
// Different approaches across files:
deps?.taskService || new TaskService({...})           // Some files
depsInput?.taskService || createConfiguredTaskService() // Others
deps.taskService || createTaskService()                // Others
```

## Requirements

### 1. **Create Unified Dependency Container**
- Design `SessionDependencies` interface covering all operations
- Include: `taskService`, `gitService`, `sessionDB`, `repositoryBackend`, `workspaceUtils`
- Support both injection and lazy creation patterns

### 2. **Implement Dependency Factory**
- Create `createSessionDependencies(options)` function
- Handle configuration-aware service creation  
- Provide consistent fallback behavior
- Support operation-specific overrides

### 3. **Update All Session Operations**
- Migrate `approve`, `merge`, `review`, `start`, `pr` operations
- Use unified dependency pattern
- Maintain backward compatibility for tests
- Remove duplicated dependency setup code

### 4. **Enhance Testing Support**
- Create standard mock factories for session dependencies
- Provide test utilities for common dependency scenarios
- Ensure easy mocking without breaking encapsulation

## Implementation Plan

### Phase 1: Design & Foundation
- [ ] Define unified `SessionDependencies` interface
- [ ] Create `SessionDependencyFactory` class
- [ ] Add configuration-aware service creation
- [ ] Build test utilities and mock factories

### Phase 2: Migration
- [ ] Update session operations one by one
- [ ] Verify existing tests continue to pass
- [ ] Update test mocks to use new patterns
- [ ] Remove duplicate dependency code

### Phase 3: Validation
- [ ] End-to-end testing with different backends
- [ ] Performance testing for dependency creation
- [ ] Documentation updates

## Success Criteria
- [ ] Single, consistent dependency injection pattern
- [ ] Reduced code duplication by 60%+
- [ ] All session operations use unified dependencies
- [ ] Existing tests pass without major rewrites
- [ ] New dependency pattern is well-documented
- [ ] Easy to add new session operations

## Benefits
- **Maintainability**: Single pattern to learn and maintain
- **Testability**: Consistent mocking approach
- **Extensibility**: Easy to add new dependencies or operations
- **Performance**: Potential for dependency caching
- **Developer Experience**: Clear, predictable patterns

## Priority
**Medium** - Improves code quality and maintainability, enables easier future development

## Requirements

## Solution

## Notes
