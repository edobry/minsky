---
name: develop-codemod
description: >-
  Develop safe, effective codemods using AST-based approaches with mandatory
  boundary validation. Use when writing a codemod, migrating patterns, automating
  code transformations, or fixing import paths across the codebase.
user-invocable: true
---

# Develop Codemod

Develop safe, effective codemods using AST-based approaches. Includes mandatory boundary validation testing before deployment.

## Arguments

Optional: description of the transformation needed (e.g., `/develop-codemod rename all imports from utils/ to shared/`).

## Core principles

- **AST over regex.** AST-based codemods are 6x more effective (231 fixes at 100% vs regex's ~85% success rate).
- **Root cause over symptoms.** One simple algorithm that handles all cases beats many specific patterns.
- **Structure-aware over pattern matching.** Calculate actual paths using filesystem APIs, don't match string patterns.

## Process

### 1. Problem analysis

Before writing any code:

- **Identify root cause**: Am I treating symptoms or the core issue?
- **Define the simplest principle** that addresses the problem
- **Plan AST-first**: Design using ts-morph/jscodeshift, not regex
- **Scope the blast radius**: How many files? What directory levels?

### 2. Implementation

Use the `StructureAwareCodemod` pattern:

```typescript
interface StructureAwareCodemod {
  analyzeDirectoryStructure(): DirectoryAnalysis;
  calculateCorrectPath(sourceFile: string, targetModule: string): string;
  transformWithAST(sourceFile: SourceFile): void;
  verifyAndReport(): TransformationReport;
}
```

**Required tools**: ts-morph, jscodeshift, or babel-codemod for AST manipulation. Node.js `path` utilities for cross-platform path calculations.

**Prohibited approaches**:

- Regex-based string replacement
- ESLint-dependent automation (fragile, environment-specific)
- Line-number based modifications (break with concurrent changes)
- Limited-window scope analysis (5-line lookahead misses broader usage)
- Bulk regex pattern application (unpredictable interactions)

### 3. Boundary validation (MANDATORY)

All codemods must complete this 5-step methodology before deployment:

**Step 1 — Reverse engineering**: Document what the codemod claims to do, targets, method, and scope.

**Step 2 — Technical analysis**: Assess scope awareness, usage verification, conflict detection, context awareness, error handling, and environment independence.

**Step 3 — Test design**: Create boundary violation test cases — used variables that shouldn't change, scope conflicts, legitimate naming conventions, complex scoping scenarios.

**Step 4 — Validation execution**: Run on test scenarios, check for compilation errors, document all changes and failures, calculate success rate and false positive rate.

**Step 5 — Decision**: Evidence-based keep/remove decision. Document anti-pattern classification and recommended alternatives.

### 4. Safety verification

Before deployment:

- [ ] Zero compilation errors introduced
- [ ] Zero scope violations (no variable conflicts or broken references)
- [ ] All 5 boundary validation steps completed with documentation
- [ ] Evidence-based decision documented
- [ ] Rollback capability available

## Anti-patterns discovered (from Tasks #166, #178)

| Anti-pattern                         | Example                                  | Why it fails                                      |
| ------------------------------------ | ---------------------------------------- | ------------------------------------------------- |
| ESLint-dependent renaming            | Parse ESLint output → regex replace      | Fragile, breaks with config changes               |
| Limited-window analysis              | 5-line lookahead for variable usage      | Misses usage outside window                       |
| Bulk pattern replacement             | 24+ regex patterns for variable contexts | Unpredictable interactions, no scope verification |
| Parameter modification without scope | Regex on function parameters             | Creates duplicate parameters, broken references   |
| Complex pattern-specific solutions   | Enumerated context patterns              | Simple root-cause approach is 6x more effective   |

## Development workflow

1. **Analysis & Design**: Root cause identification → simple principle → AST-first design
2. **Implementation**: AST-based with safety mechanisms (scope analysis, conflict detection, error handling)
3. **Boundary Validation**: 5-step methodology with comprehensive test suite
4. **Deployment**: Only after passing all validation tests

## Key principles

- **100% compilation safety.** Zero syntax errors introduced.
- **Zero scope violations.** No variable conflicts or broken references.
- **Structure awareness over pattern matching.** Use `path.relative()` not `importPath.includes()`.
- **Simple beats complex.** 239 fixes in one run vs 284 across multiple iterations.
- **Document at the top.** Boundary validation results go in the codemod file's docstring, not separate files.
