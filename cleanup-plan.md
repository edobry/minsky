# "as unknown" Cleanup Plan

## Analysis Results Summary
- **Total assertions**: 2,728
- **High priority (error-masking)**: 2,461 (90%)
- **Medium priority**: 156 (6%)
- **Low priority**: 111 (4%)

## Key Findings
The analysis reveals several critical patterns that are masking type errors:

### 1. Property Access Masking (Most Common)
```typescript
// WRONG - Masking property access
(this.config as unknown).path
(process.env as unknown).HOME
(state.sessions as unknown).length

// CORRECT - Proper typing
this.config.path  // with proper Config interface
process.env.HOME  // with proper env typing
state.sessions.length  // with proper State interface
```

### 2. Null/Undefined Masking (Most Dangerous)
```typescript
// WRONG - Masking null/undefined
undefined as unknown
null as unknown
return undefined as unknown

// CORRECT - Proper optional types
return undefined  // with proper return type
return null       // with proper return type
```

### 3. This Context Masking (Type Errors)
```typescript
// WRONG - Masking this context
(this as unknown).name = "SessionNotFoundError"

// CORRECT - Proper class typing
this.name = "SessionNotFoundError"  // with proper class definition
```

## Cleanup Strategy

### Phase 1: High-Impact Quick Wins (Target: 500+ assertions)
Focus on the most common patterns that can be automated:

1. **Environment Variable Access** (~50 instances)
   - Fix `(process.env as unknown).HOME` → `process.env.HOME!`
   - Add proper env typing

2. **Property Access on Known Types** (~200 instances)
   - Fix config access patterns
   - Fix state access patterns
   - Add proper interface definitions

3. **Return Statement Fixes** (~100 instances)
   - Fix `return undefined as unknown`
   - Fix `return null as unknown`
   - Use proper return types

### Phase 2: Domain-Specific Fixes (Target: 800+ assertions)
Focus on core domain areas:

1. **Session Management** (~300 instances)
   - `src/domain/session/` files
   - Fix session state access
   - Fix session provider patterns

2. **Task Management** (~200 instances)
   - `src/domain/tasks/` files
   - Fix task state access
   - Fix task provider patterns

3. **Storage/Repository** (~150 instances)
   - `src/domain/storage/` files
   - Fix backend access patterns
   - Fix repository patterns

### Phase 3: Adapter Fixes (Target: 400+ assertions)
Focus on adapter layers:

1. **CLI Adapters** (~150 instances)
   - Fix command parameter handling
   - Fix option parsing

2. **MCP Adapters** (~100 instances)
   - Fix tool parameter handling
   - Fix response formatting

### Phase 4: Test File Cleanup (Target: 300+ assertions)
Focus on test files:

1. **Mock Improvements** (~120 instances)
   - Replace mock casting with proper types
   - Use proper test utilities

2. **Test Data Setup** (~100 instances)
   - Fix test data casting
   - Use proper test fixtures

## Implementation Plan

### Step 1: Create Automated Fixes
Create scripts to handle the most common patterns:
- Property access on known types
- Environment variable access
- Return statement fixes
- Null/undefined masking

### Step 2: Domain-by-Domain Cleanup
Work through each domain systematically:
- Session management first (highest impact)
- Task management second
- Storage/repository third

### Step 3: Verify and Test
After each domain:
- Run TypeScript compilation
- Run full test suite
- Verify no regressions

### Step 4: Prevention
- Add ESLint rules
- Update TypeScript configuration
- Document approved patterns

## Success Metrics
- **Target reduction**: 50%+ (from 2,728 to <1,364)
- **High priority elimination**: 80%+ (from 2,461 to <492)
- **Zero regressions**: All tests must pass
- **Type safety improved**: Better TypeScript compilation

## Risk Mitigation
- Work in session workspace (isolated)
- Test after each major change
- Focus on automated fixes first
- Document any legitimate uses that must remain

## Next Steps
1. Start with automated fixes for common patterns
2. Focus on session domain files first
3. Verify changes don't break functionality
4. Continue domain by domain 
