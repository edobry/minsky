# AS-UNKNOWN AST Codemod Specification

## Overview

This codemod systematically removes excessive `as unknown` type assertions throughout the codebase to improve TypeScript effectiveness and reduce technical debt.

## Problem Statement

The codebase contains 2,728 `as unknown` assertions, with 2,461 classified as high priority (error-masking). These assertions:
- Mask real type errors and import issues
- Reduce TypeScript's effectiveness in catching bugs
- Make code harder to maintain and understand
- Create technical debt

## Analysis Results

From initial scan:
- **Total assertions**: 2,728
- **High priority (error-masking)**: 2,461 (90%)
- **Medium priority**: 156 (6%)
- **Low priority**: 111 (4%)

## Transformation Patterns

### 1. Property Access Patterns (HIGH PRIORITY)

#### Pattern: State/Session Object Access
```typescript
// BEFORE (unsafe)
(state as unknown).sessions
(state.sessions as unknown).length
(s as unknown).session
(session as unknown).taskId

// AFTER (safe)
state.sessions
state.sessions.length
s.session
session.taskId
```

#### Pattern: Service Method Calls
```typescript
// BEFORE (unsafe)
(this.sessionProvider as unknown).getSession(name)
(this.pathResolver as unknown).getRelativePathFromSession(dir, path)
(this.workspaceBackend as unknown).readFile(dir, path)

// AFTER (safe)
this.sessionProvider.getSession(name)
this.pathResolver.getRelativePathFromSession(dir, path)
this.workspaceBackend.readFile(dir, path)
```

#### Pattern: Configuration Access
```typescript
// BEFORE (unsafe)
(this.config as unknown).path
(process.env as unknown).HOME

// AFTER (safe)
this.config.path
process.env.HOME
```

### 2. Array/Object Method Access (HIGH PRIORITY)

```typescript
// BEFORE (unsafe)
(sessions as unknown).find(s => s.id === id)
(issues as unknown).push(newIssue)
(items as unknown).length

// AFTER (safe)
sessions.find(s => s.id === id)
issues.push(newIssue)
items.length
```

### 3. Return Statement Patterns (CRITICAL PRIORITY)

```typescript
// BEFORE (dangerous)
return null as unknown;
return undefined as unknown;

// AFTER (safe)
return null;
return undefined;
```

### 4. Null/Undefined Patterns (CRITICAL PRIORITY)

```typescript
// BEFORE (dangerous)
const result = undefined as unknown;
const value = null as unknown;

// AFTER (safe)
const result = undefined;
const value = null;
```

### 5. This Context Patterns (HIGH PRIORITY)

```typescript
// BEFORE (unsafe)
(this as unknown).name = "ErrorName";

// AFTER (safe)
this.name = "ErrorName";
```

## Risk Assessment

### Critical Risk (Immediate Fix Required)
- Return statement masking: `return null as unknown`
- Null/undefined masking: `null as unknown`, `undefined as unknown`
- Error handling masking in domain code

### High Risk (High Priority)
- Property access masking in domain files
- Service method call masking
- Array/object method masking
- This context masking

### Medium Risk (Medium Priority)
- Configuration access patterns
- Test utility patterns
- Parameter passing patterns

### Low Risk (Low Priority)
- Test mocking patterns (may be legitimate)
- Type bridging for JSON parsing
- Documented legitimate uses

## Implementation Strategy

### Phase 1: AST Analysis
1. Parse all TypeScript files using ts-morph
2. Identify `AsExpression` nodes with `unknown` type
3. Analyze context and categorize by risk level
4. Build transformation plan

### Phase 2: Safe Transformations
1. Start with critical risk patterns
2. Apply high-confidence transformations
3. Skip patterns requiring manual review
4. Record all changes for verification

### Phase 3: Validation
1. Ensure TypeScript compilation still works
2. Run full test suite to verify no regressions
3. Generate detailed transformation report

## Test Requirements

### Unit Tests
- Test each transformation pattern individually
- Verify AST node identification accuracy
- Test edge cases and boundary conditions
- Validate context analysis logic

### Integration Tests
- Test on real codebase files
- Verify compilation after transformations
- Test interaction between multiple patterns
- Validate reporting and metrics

### Regression Tests
- Test cases from failed transformations
- Edge cases that broke in development
- Complex nested patterns
- Multi-line expressions

## Success Metrics

- **Target reduction**: 50%+ (from 2,728 to <1,364)
- **High priority elimination**: 80%+ (from 2,461 to <492)
- **Zero regressions**: All tests must pass
- **TypeScript compilation**: Must continue to work
- **Type safety**: Improved overall type checking

## Files to Transform

### Core Domain Files (High Priority)
- `src/domain/session/` - 300+ assertions
- `src/domain/tasks/` - 200+ assertions  
- `src/domain/storage/` - 150+ assertions
- `src/domain/workspace/` - 100+ assertions

### Adapter Files (Medium Priority)
- `src/adapters/cli/` - 150+ assertions
- `src/adapters/mcp/` - 100+ assertions
- `src/adapters/shared/` - 50+ assertions

### Test Files (Low Priority)
- `**/*.test.ts` - 300+ assertions
- `tests/` - 200+ assertions

## Exclusions

### Patterns to Keep (For Now)
- Well-documented legitimate type bridging
- Complex generic type scenarios
- External library integration points
- Performance-critical code sections

### Manual Review Required
- Complex nested expressions
- Multi-line type assertions
- Dynamic property access
- Plugin/extension patterns

## Output Format

### Transformation Report
```
📊 AS-UNKNOWN TRANSFORMATION REPORT
==================================
Files Processed: 173
Total Assertions Before: 2,728
Total Assertions After: 1,364
Assertions Removed: 1,364 (50.0%)

By Risk Level:
  Critical: 450 → 90 (80% reduction)
  High: 2,011 → 600 (70% reduction)
  Medium: 156 → 124 (20% reduction)
  Low: 111 → 550 (0% reduction)

By Pattern Type:
  Property Access: 800 fixed
  Service Methods: 300 fixed
  Array Operations: 200 fixed
  Return Statements: 64 fixed
  Null/Undefined: 100 fixed
```

## Dependencies

- `ts-morph`: AST parsing and transformation
- `glob`: File pattern matching
- `@types/node`: TypeScript definitions
- Codemod framework utilities

## Related Tasks

- Task #280: Cleanup excessive 'as unknown' assertions
- Task #276: Test suite optimization (identified the problem)
- Task #271: Risk-aware type cast fixing (similar patterns) 
