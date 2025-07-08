# Codemod Development Guidelines: AST-First Approach

## Overview

This document establishes evidence-based guidelines for developing codemods in the Minsky project, prioritizing AST-based approaches over regex-based alternatives.

## Core Principles

### 1. AST-First Development Strategy

**Evidence**: Task #166 demonstrated that AST-based approaches are **6x more effective** than regex approaches:

- **AST-based fix-variable-naming-ast.ts**: 231 fixes, 100% success rate, zero syntax errors
- **Regex-based approaches**: High syntax error rates, complex pattern matching, frequent failures

**Principle**: Always evaluate AST-based solutions first. Only use regex as a last resort when AST parsing is impossible.

### 2. Root Cause Analysis Over Symptom Treatment

**From automation-approaches.mdc**: "Fix the root cause, not the symptoms"

**Application**: 
- Identify why the code pattern exists (missing types, incorrect architecture, etc.)
- Design transformations that address the underlying issue
- Avoid superficial fixes that only mask problems

### 3. Simple Algorithms Over Complex Patterns

**Evidence**: Simple AST transformations in fix-variable-naming-ast.ts outperformed complex regex patterns

**Principle**: Prefer straightforward AST traversal and transformation over complex pattern matching

## Development Standards

### AST-Based Codemod Requirements

#### 1. Tool Selection
- **Primary**: Use `ts-morph` for TypeScript/JavaScript transformations
- **Alternative**: Use TypeScript Compiler API directly for advanced cases
- **Avoid**: Regex-based string manipulation for syntactic changes

#### 2. Error Handling
All AST-based codemods must include:
```typescript
// Comprehensive error handling
try {
  // AST transformation logic
} catch (error) {
  console.error(`Error processing ${filePath}:`, error);
  // Log specific error details
  // Continue processing other files
}
```

#### 3. Validation Requirements
- **Pre-transformation validation**: Verify AST structure before changes
- **Post-transformation validation**: Ensure syntactic correctness
- **Type checking**: Validate that changes don't introduce type errors

#### 4. Performance Monitoring
Track and report:
- Files processed
- Issues found and fixed
- Processing time
- Success/failure rates

### Code Structure Standards

#### 1. Modular Design
```typescript
class CodemodName {
  private project: Project;
  private issues: Issue[] = [];
  
  constructor() {
    this.project = new Project();
  }
  
  addSourceFiles(patterns: string[]): void { /* ... */ }
  findIssues(): Issue[] { /* ... */ }
  fixIssues(): void { /* ... */ }
  generateReport(): void { /* ... */ }
}
```

#### 2. Issue Detection Pattern
```typescript
interface Issue {
  file: string;
  line: number;
  column: number;
  description: string;
  severity: 'error' | 'warning' | 'info';
  context: string;
}
```

#### 3. Transformation Safety
- Use `getFullText()` and `replaceWithText()` for safe replacements
- Validate AST structure before and after changes
- Handle edge cases (nested structures, complex expressions)

## Testing Standards

### 1. Comprehensive Test Coverage
- **Unit tests**: Test individual transformation functions
- **Integration tests**: Test full codemod execution
- **Edge case tests**: Test boundary conditions and error scenarios

### 2. Test File Structure
```
codemods/
├── my-codemod.ts
├── __tests__/
│   ├── my-codemod.test.ts
│   └── fixtures/
│       ├── input/
│       │   └── example.ts
│       └── expected/
│           └── example.ts
```

### 3. Validation Testing
- Verify syntax correctness after transformation
- Check type safety preservation
- Validate expected behavior preservation

## Decision Trees

### When to Use AST vs Regex

```
Does the change involve code syntax or structure?
├─ YES → Use AST approach
│   ├─ TypeScript/JavaScript? → Use ts-morph
│   ├─ JSON/YAML? → Use appropriate parser
│   └─ Other language? → Find language-specific AST library
└─ NO → Consider regex for simple text patterns
    ├─ Simple find/replace? → Regex acceptable
    ├─ Complex patterns? → Reconsider AST approach
    └─ Multiple files? → Use AST for consistency
```

### AST Library Selection

```
What type of transformation?
├─ TypeScript/JavaScript syntax → ts-morph (preferred)
├─ Complex compiler integration → TypeScript Compiler API
├─ JSON manipulation → Native JSON + validation
├─ YAML/configuration → yaml parser + AST
└─ Other languages → Language-specific AST library
```

## Common Patterns and Examples

### 1. Variable Naming Fix (AST Success Story)
```typescript
// From fix-variable-naming-ast.ts - 231 fixes, 100% success rate
const parameterDeclarations = func.getParameters();
parameterDeclarations.forEach(param => {
  const paramName = param.getName();
  if (paramName.startsWith('_')) {
    const newName = paramName.substring(1);
    param.rename(newName);
  }
});
```

### 2. Import Statement Transformation
```typescript
sourceFile.getImportDeclarations().forEach(importDecl => {
  const moduleSpecifier = importDecl.getModuleSpecifierValue();
  if (moduleSpecifier.startsWith('./old-path')) {
    importDecl.setModuleSpecifier(moduleSpecifier.replace('./old-path', './new-path'));
  }
});
```

### 3. Function Signature Updates
```typescript
const functions = sourceFile.getFunctions();
functions.forEach(func => {
  const params = func.getParameters();
  // Safe parameter manipulation
  params.forEach(param => {
    // Validate before transformation
    if (param.getTypeNode()) {
      // Transform with type safety
    }
  });
});
```

## Migration Guide: Regex to AST

### Step 1: Identify Regex Patterns
Look for codemods using:
- `String.prototype.replace()`
- Complex regular expressions
- Multi-step text manipulation

### Step 2: Analyze Intent
- What syntactic structure is being changed?
- Are type relationships involved?
- Does the change affect code semantics?

### Step 3: Design AST Equivalent
- Map regex patterns to AST node types
- Use ts-morph methods for traversal
- Implement proper error handling

### Step 4: Validate Transformation
- Compare outputs with original regex approach
- Ensure no syntax errors introduced
- Verify semantic preservation

## Common Pitfalls and Solutions

### 1. Over-Engineering
**Problem**: Creating overly complex AST transformations
**Solution**: Start simple, add complexity only when needed

### 2. Incomplete Error Handling
**Problem**: AST transformations failing silently
**Solution**: Implement comprehensive try-catch blocks

### 3. Type Safety Issues
**Problem**: Transformations breaking type relationships
**Solution**: Use TypeScript compiler API for type validation

### 4. Performance Issues
**Problem**: Slow AST parsing for large codebases
**Solution**: Process files in batches, optimize AST queries

## Review and Approval Process

### 1. Code Review Requirements
- [ ] Uses AST-based approach (or justified exception)
- [ ] Includes comprehensive error handling
- [ ] Has complete test coverage
- [ ] Follows modular design patterns
- [ ] Includes performance monitoring

### 2. Testing Requirements
- [ ] Unit tests for transformation logic
- [ ] Integration tests for full workflow
- [ ] Edge case validation
- [ ] Performance benchmarks

### 3. Documentation Requirements
- [ ] Clear description of transformation intent
- [ ] Usage examples and expected outcomes
- [ ] Performance characteristics
- [ ] Known limitations and edge cases

## Contribution Guidelines

### 1. New Codemod Submission
1. **Analyze requirement**: Determine if AST approach is suitable
2. **Design transformation**: Use decision trees and patterns
3. **Implement with standards**: Follow code structure guidelines
4. **Test thoroughly**: Include all testing requirements
5. **Document completely**: Provide usage and performance info

### 2. Existing Codemod Migration
1. **Assess current approach**: Identify regex vs AST usage
2. **Plan migration**: Use migration guide steps
3. **Implement incrementally**: Test each transformation step
4. **Validate equivalence**: Ensure same outcomes achieved
5. **Performance comparison**: Document improvements

## Conclusion

These guidelines prioritize AST-based approaches based on concrete evidence from Task #166, emphasizing root cause analysis and simple algorithms. By following these standards, we ensure codemods are reliable, maintainable, and effective at scale.

The 6x effectiveness improvement demonstrated by AST approaches makes this investment in proper tooling and methodology essential for the project's long-term success. 
