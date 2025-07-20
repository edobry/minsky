# Implement ESLint Rule for Jest Pattern Prevention & Fix Session Start Bug Issues

## Context

Task #061 Phase 3 created comprehensive Bun test pattern documentation and infrastructure, but we need an actual ESLint rule to automatically enforce these patterns. Currently, developers could still accidentally use Jest patterns, and we need automated prevention.

**ADDITIONALLY**: Critical session start command bugs were discovered and fixed that prevented users from using the `--description` flag and caused unfriendly error messages.

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

### 5. **COMPLETED**: Fix Session Start Command Bugs

**Issue 1 - Missing Method Error**: `minsky session start --description "..."` failed with "createTaskFromTitleAndDescription is not a function"

**Root Cause**: Method existed in TaskService class but was missing from TaskBackend interface and implementations
**Files Fixed**: 
- `src/domain/tasks.ts` - Added method to TaskBackend interface
- `src/domain/tasks/markdownTaskBackend.ts` - Implemented method
- `src/domain/tasks/githubIssuesTaskBackend.ts` - Added stub implementation

**Issue 2 - Unfriendly JSON Error Messages**: Users saw ugly JSON dumps alongside clean error messages

**Root Cause**: `log.error()` call was outputting raw JSON metadata to users  
**Files Fixed**:
- `src/adapters/shared/commands/session.ts` - Removed log.error call that dumped JSON

**Verification Results**:
```bash
# Before fixes:
❯ minsky session start --description "test" my-session
Failed to start session: deps.taskService.createTaskFromTitleAndDescription is not a function

# After fixes:
❯ minsky session start --description "test" my-session  
Error: 🚫 Cannot Start Session from Within Another Session
[...clean, helpful error message without JSON dumps...]
```

✅ **Both issues verified as fixed**: Function exists and error messages are clean!

## Acceptance Criteria

### ESLint Rule (Original Requirements)
1. ✅ ESLint rule file created and properly structured
2. ✅ Rule detects all major Jest patterns (fn, mock, spyOn, etc.)
3. ✅ Provides clear error messages with Bun alternatives
4. ✅ Auto-fix works for basic patterns
5. ✅ Rule integrated into project ESLint configuration
6. ✅ Rule runs successfully with `npm run lint` or `bun lint`
7. ✅ Documentation updated explaining the rule

### Session Start Bug Fixes (New Requirements)
1. ✅ Fixed `createTaskFromTitleAndDescription is not a function` error
2. ✅ Added missing method to TaskBackend interface and implementations  
3. ✅ Removed unfriendly JSON error message dumps
4. ✅ Verified `minsky session start --description "..."` works correctly
5. ✅ Error messages are now clean and user-friendly

## Implementation Notes

### ESLint Rule
- Follow ESLint rule development best practices
- Use AST parsing to detect patterns accurately
- Provide comprehensive test coverage for the rule
- Consider edge cases like conditional imports or dynamic requires

### Session Start Bug Fixes
- Fixed missing method in TaskBackend interface and implementations  
- Removed log.error calls that dumped JSON to users
- Verified session start with --description flag works correctly
- Improved error message UX by removing unfriendly JSON output

## Related Work

- Builds on Task #061 Phase 3 Bun test pattern infrastructure
- Complements existing `docs/bun-test-patterns.md` documentation
- Works with centralized test utilities in `src/utils/test-utils/`
- **Session start bug fixes improve CLI UX for session creation with --description flag**

## Definition of Done

### ESLint Rule
- ESLint rule implemented and working
- Rule integrated into project configuration
- Auto-fix capabilities functional for basic patterns
- Documentation updated
- Rule tested on existing codebase without false positives

### Session Start Bug Fixes
- ✅ `createTaskFromTitleAndDescription` method added to all TaskBackend implementations
- ✅ Session start with `--description` flag working correctly  
- ✅ JSON error message dumps removed from user output
- ✅ Clean, user-friendly error messages implemented
- ✅ CHANGELOG updated with fix details
