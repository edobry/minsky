# Implement Cross-Cutting Session Auto-Detection

## Problem

Session auto-detection logic is currently implemented inconsistently across session commands. While some commands have auto-detection, this leads to:

1. **Code Duplication**: Same auto-detection logic copied across multiple functions with different implementations
2. **Inconsistency**: Different commands use different utilities (`getCurrentSession`, `getCurrentSessionContext`, manual path parsing)
3. **Maintenance Burden**: Updates to auto-detection logic require changes in multiple places
4. **Missing Coverage**: Some core session commands still lack auto-detection entirely

## Current State Analysis

**✅ Commands with Auto-Detection:**

- `session.pr` - Uses manual directory path parsing
- `session.update` - Uses `getCurrentSession` utility
- `session.approve` - Uses `getCurrentSession` utility
- `session.inspect` - Uses `getCurrentSessionContext` utility
- `session.review` - Uses `getCurrentSession` utility

**❌ Commands Still Missing Auto-Detection:**

- `session.get` - Still requires explicit name/task parameters
- `session.delete` - Still requires explicit name/task parameters

**🔄 Inconsistent Implementations:**
Each command implements auto-detection differently:

- Different utility functions (`getCurrentSession` vs `getCurrentSessionContext`)
- Different error handling patterns
- Different feedback messages

## Proposed Solution

Create a **unified session context resolver** that standardizes auto-detection across all session commands:

### Option 1: Session Context Middleware

Create middleware that runs before command execution to auto-populate session parameters with consistent error handling.

### Option 2: Enhanced Parameter Schema

Extend the parameter schema system to support auto-detection annotations that work consistently across all commands.

### Option 3: Unified Session Context Provider

Implement a single context provider that all session commands use, with standardized error messages and feedback.

## Commands That Need Updates

- [x] `session.pr` (✅ has auto-detection, needs standardization)
- [x] `session.update` (✅ has auto-detection, needs standardization)
- [x] `session.approve` (✅ has auto-detection, needs standardization)
- [x] `session.inspect` (✅ has auto-detection, needs standardization)
- [x] `session.review` (✅ has auto-detection, needs standardization)
- [ ] `session.get` (❌ missing auto-detection)
- [ ] `session.delete` (❌ missing auto-detection)

**Note:** `session.dir` is excluded because if you're in the session, you already know the directory.

## Benefits

1. **Consistency**: All session commands behave the same way
2. **DRY Principle**: Auto-detection logic defined once
3. **Better UX**: Users don't need to specify session names when in session workspaces
4. **Easier Maintenance**: Single place to update auto-detection logic
5. **Standardized Error Messages**: Consistent feedback across all commands

## Implementation Plan

1. **Create Unified Session Context Resolver**

   - Consolidate existing auto-detection utilities
   - Standardize error handling and feedback messages
   - Create consistent parameter injection approach

2. **Update Commands with Existing Auto-Detection**

   - Migrate to unified resolver
   - Standardize error messages
   - Ensure consistent behavior

3. **Add Auto-Detection to Missing Commands**

   - `session.get` - Auto-detect when no name/task provided
   - `session.delete` - Auto-detect when no name/task provided

4. **Testing and Validation**
   - Comprehensive tests for all auto-detection scenarios
   - Consistent error handling validation
   - User experience testing

## Acceptance Criteria

- [ ] All relevant session commands support auto-detection using the same utility
- [ ] Auto-detection logic is implemented in a single, reusable location
- [ ] Consistent error messages and feedback across all commands
- [ ] No breaking changes to existing command interfaces
- [ ] Commands with existing auto-detection are migrated to unified approach
- [ ] Commands missing auto-detection are updated to support it
- [ ] Documentation updated to reflect auto-detection capabilities
- [ ] Comprehensive tests validate consistent behavior

## Success Metrics

- Zero code duplication for session auto-detection logic
- Consistent user experience across all session commands
- Single source of truth for session context resolution
- Maintainable and extensible session command architecture
