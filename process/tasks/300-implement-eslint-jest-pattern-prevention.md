# Implement ESLint Rule for Jest Pattern Prevention

## Context

Task #061 Phase 3 created comprehensive Bun test pattern documentation and infrastructure, but we need an actual ESLint rule to automatically enforce these patterns. Currently, developers could still accidentally use Jest patterns, and we need automated prevention.

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

## Acceptance Criteria

1. ✅ ESLint rule file created and properly structured
2. ✅ Rule detects all major Jest patterns (fn, mock, spyOn, etc.)
3. ✅ Provides clear error messages with Bun alternatives
4. ✅ Auto-fix works for basic patterns
5. ✅ Rule integrated into project ESLint configuration
6. ✅ Rule runs successfully with `npm run lint` or `bun lint`
7. ✅ Documentation updated explaining the rule

## Implementation Notes

- Follow ESLint rule development best practices
- Use AST parsing to detect patterns accurately
- Provide comprehensive test coverage for the rule
- Consider edge cases like conditional imports or dynamic requires

## Related Work

- Builds on Task #061 Phase 3 Bun test pattern infrastructure
- Complements existing `docs/bun-test-patterns.md` documentation
- Works with centralized test utilities in `src/utils/test-utils/`

## Definition of Done

- ESLint rule implemented and working
- Rule integrated into project configuration
- Auto-fix capabilities functional for basic patterns
- Documentation updated
- Rule tested on existing codebase without false positives
