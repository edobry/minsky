# Implement Cross-Cutting Session Auto-Detection

## Problem

Session auto-detection logic is currently implemented manually in individual commands (`sessionPrFromParams`, `updateSessionFromParams`). This leads to:

1. **Code Duplication**: Same auto-detection logic copied across multiple functions
2. **Inconsistency**: Different commands may implement auto-detection differently
3. **Maintenance Burden**: Updates to auto-detection logic require changes in multiple places
4. **Missing Coverage**: Some commands that should support auto-detection don't have it

## Current Implementation

Currently, auto-detection is manually implemented like this:

```typescript
// Auto-detect session name if not provided
if (!name) {
  try {
    const currentSession = getCurrentSession();
    if (currentSession?.session) {
      name = currentSession.session;
      log.cli(`Auto-detected session: ${name}`);
    } else {
      throw new ValidationError("Session name is required when not in a session workspace");
    }
  } catch (error) {
    throw new ValidationError("Session name is required and could not be auto-detected");
  }
}
```

## Proposed Solution

Implement **context injection** for session auto-detection that works across all session commands:

### Option 1: Parameter Middleware

Create middleware that runs before command execution to auto-populate session parameters.

### Option 2: Context Provider

Implement a context provider that commands can request session information from.

### Option 3: Enhanced Parameter Schema

Extend the parameter schema system to support auto-detection annotations.

## Commands That Should Support Auto-Detection

- [ ] `session.pr` (✅ currently implemented)
- [ ] `session.update` (✅ currently implemented)
- [ ] `session.get` (❌ missing)
- [ ] `session.delete` (❌ missing)
- [ ] `session.dir` (❌ missing)
- [ ] `session.approve` (❌ missing)

## Benefits

1. **Consistency**: All session commands behave the same way
2. **DRY Principle**: Auto-detection logic defined once
3. **Better UX**: Users don't need to specify session names when in session workspaces
4. **Easier Maintenance**: Single place to update auto-detection logic

## Acceptance Criteria

- [ ] All session commands support auto-detection when appropriate
- [ ] Auto-detection logic is implemented in a single, reusable location
- [ ] Consistent error messages across commands
- [ ] No breaking changes to existing command interfaces
- [ ] Documentation updated to reflect auto-detection capabilities
