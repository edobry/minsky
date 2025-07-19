# Implement ESLint Rule for Jest Pattern Prevention & Fix Session Approval Error Handling

## Context

Task #061 Phase 3 created comprehensive Bun test pattern documentation and infrastructure, but we need an actual ESLint rule to automatically enforce these patterns. Currently, developers could still accidentally use Jest patterns, and we need automated prevention.

**ADDITIONALLY**: Session approval command has critical error handling bugs that need immediate fixing for better UX.

## Requirements

### 1. Create ESLint Rule Implementation

**File**: `src/eslint-rules/no-jest-patterns.js`

**Rule Capabilities**:
- Detect Jest imports (`import { jest } from ...`, `import jest from ...`)
- Detect Jest method calls (`jest.fn()`, `jest.mock()`, `jest.spyOn()`)
- Detect Jest-style mocking patterns (`.mockImplementation()`, `.mockReturnValue()`, etc.)
- Provide auto-fix suggestions where possible
- Give clear error messages pointing to Bun alternatives

**Error Messages**:
- `jest.fn()` → "Use Bun test patterns: import { mock } from 'bun:test'; const mockFn = mock();"
- `jest.mock()` → "Use centralized mockModule() from test-utils/mocking.ts"
- Jest imports → "Use Bun test imports instead of Jest"

### 2. ESLint Configuration Integration

**File**: `.eslintrc.js` or `eslint.config.js`

Add the custom rule to project ESLint configuration:
```javascript
{
  "rules": {
    "./src/eslint-rules/no-jest-patterns": "error"
  }
}
```

### 3. Auto-Fix Capabilities

Implement automatic fixes for common patterns:
- `jest.fn()` → `mock()` (with appropriate import)
- Simple `.mockReturnValue()` → Bun equivalent
- Jest import statements → Bun import statements

### 4. Integration with Development Workflow

- Ensure rule runs in existing lint commands
- Verify integration with pre-commit hooks (if any)
- Test with IDE ESLint extensions

### 5. **NEW**: Fix Session Approval Error Handling Bug

**Issue Discovered**: `minsky session approve --task 3283` produces incorrect error handling:

**Problems**:
1. Claims "Task 3283 exists but has no session" when task 3283 doesn't exist at all
2. Overly verbose and confusing error message provides wrong guidance
3. Validation logic checks for session before validating task existence

**Required Fix**:
- **File**: Locate session approval command implementation (likely in `src/adapters/mcp/session.ts` or similar)
- **Logic Fix**: Validate task existence BEFORE checking for session
- **Error Message Improvement**: Provide clear, concise messages for different scenarios:
  - Task doesn't exist: "❌ Task not found: 3283"
  - Task exists but no session: "❌ No session found for task 3283"
  - Clear guidance without overwhelming verbosity

**Expected Behavior**:
```bash
❯ minsky session approve --task 3283
❌ Task not found: 3283

The specified task does not exist.

💡 Available options:
• Run 'minsky tasks list' to see all available tasks
• Check your task ID for typos
• Use 'minsky session list' to see tasks with active sessions
```

## Acceptance Criteria

### ESLint Rule (Original Requirements)
1. ✅ ESLint rule file created and properly structured
2. ✅ Rule detects all major Jest patterns (fn, mock, spyOn, etc.)
3. ✅ Provides clear error messages with Bun alternatives
4. ✅ Auto-fix works for basic patterns
5. ✅ Rule integrated into project ESLint configuration
6. ✅ Rule runs successfully with `npm run lint` or `bun lint`
7. ✅ Documentation updated explaining the rule

### Session Approval Bug Fix (New Requirements)
1. ✅ Task existence validation implemented before session lookup
2. ✅ Clear, specific error messages for different failure scenarios
3. ✅ Error message UX improved (concise, actionable guidance)
4. ✅ Proper validation order: task exists → session exists → approval logic
5. ✅ Test coverage for error scenarios (non-existent task, task without session)

## Implementation Notes

### ESLint Rule
- Follow ESLint rule development best practices
- Use AST parsing to detect patterns accurately
- Provide comprehensive test coverage for the rule
- Consider edge cases like conditional imports or dynamic requires

### Session Approval Fix
- Locate session approval command in codebase
- Implement proper validation chain (task → session → approval)
- Update error handling to provide helpful UX
- Test with various invalid inputs (non-existent tasks, typos, etc.)

## Related Work

- Builds on Task #061 Phase 3 Bun test pattern infrastructure
- Complements existing `docs/bun-test-patterns.md` documentation
- Works with centralized test utilities in `src/utils/test-utils/`
- **Session bug fix improves overall CLI UX for session management**

## Definition of Done

### ESLint Rule
- ESLint rule implemented and working
- Rule integrated into project configuration
- Auto-fix capabilities functional for basic patterns
- Documentation updated
- Rule tested on existing codebase without false positives

### Session Approval Bug Fix
- Session approval validates task existence first
- Clear error messages for all failure scenarios
- Improved user experience with actionable guidance
- Test coverage for error handling paths
- No regression in existing functionality
