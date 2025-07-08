# Explore consolidating ESLint rules with codemods

## Status

BACKLOG

## Priority

MEDIUM

## Description

## Priority: Medium

## Description

Explore consolidating our custom ESLint rules (specifically the `no-underscore-prefix-mismatch` rule with autofix capability) with our existing codemod infrastructure. There appears to be significant conceptual overlap between ESLint autofixes and standalone codemods, and this could lead to better maintainability and unified approach to automated code fixes.

## Background

Currently we have two parallel approaches for automated code fixes:

1. **Custom ESLint Rules** (`src/eslint-rules/no-underscore-prefix-mismatch.js`):

   - Detects variable declaration/usage mismatches with underscore prefixes
   - Provides autofix capability through ESLint's fix API
   - Integrates with ESLint workflow and editor tooling
   - Runs during linting process

2. **Standalone Codemods** (`codemods/fix-variable-naming-ast.ts` and others):
   - Uses ts-morph for AST-based transformations
   - Handles similar variable naming issues
   - Runs as standalone scripts
   - More powerful for complex transformations

## Conceptual Overlap Analysis

### Similarities

- Both solve TypeScript/JavaScript code issues automatically
- Both handle variable naming issues (underscore prefix mismatches)
- Both provide fixes, not just detection
- Both are AST-based approaches (ESLint rule uses ESLint's AST, codemod uses ts-morph)
- Both follow the automation-approaches rule preference for AST-based solutions

### Differences

- **ESLint Rules**: Integrated into development workflow, runs on save/commit
- **Codemods**: One-time transformations, more powerful for bulk changes
- **ESLint Rules**: Limited to ESLint's AST and fix API
- **Codemods**: Full TypeScript compiler API access through ts-morph

## Investigation Areas

### 1. Analyze Current Redundancy

**Tasks:**

- Map all current ESLint rules with autofixes
- Identify corresponding codemods that solve similar issues
- Quantify the overlap in functionality
- Document maintenance burden of parallel approaches

**Files to examine:**

- `src/eslint-rules/no-underscore-prefix-mismatch.js`
- `codemods/fix-variable-naming-ast.ts`
- `codemods/fix-*.ts` (all variable naming related codemods)
- `eslint.config.js` (current ESLint configuration)

### 2. Evaluate Consolidation Approaches

**Option A: ESLint-First Approach**

- Expand ESLint rules to cover more cases
- Use ESLint autofixes for development-time fixes
- Keep codemods for complex one-time transformations
- Pros: Integrated workflow, real-time feedback
- Cons: Limited by ESLint's AST API

**Option B: Codemod-First Approach**

- Convert ESLint rules to codemods
- Use codemods for all automated fixes
- Keep ESLint for detection-only rules
- Pros: Full TypeScript compiler API access
- Cons: Less integrated into development workflow

**Option C: Hybrid Approach**

- ESLint rules for real-time detection and simple fixes
- Codemods for complex transformations and bulk operations
- Shared logic between both approaches
- Clear decision matrix for when to use each

### 3. Technical Feasibility Analysis

**Shared Infrastructure:**

- Can we create shared AST utilities used by both approaches?
- How to avoid duplicating pattern recognition logic?
- Can we generate ESLint rules from codemod definitions?

**Workflow Integration:**

- How to integrate codemods into ESLint workflow?
- Can we run codemods from ESLint rules?
- How to maintain editor integration benefits?

### 4. Performance and Maintenance Impact

**Performance Considerations:**

- ESLint rules run on every file change
- Codemods run on-demand for bulk changes
- Impact on development workflow speed

**Maintenance Burden:**

- Current effort to maintain both approaches
- Potential reduction with consolidation
- Long-term scalability considerations

## Decision Framework

### When to Use ESLint Rules

- Simple, frequent fixes needed during development
- Real-time feedback required
- Integration with editor tooling important
- Pattern detection with simple AST manipulations

### When to Use Codemods

- Complex AST transformations required
- Bulk operations on entire codebase
- One-time migration or refactoring tasks
- Need full TypeScript compiler API access

### Consolidation Opportunities

- Variable naming issues (current overlap)
- Type annotation fixes
- Import/export statement cleanup
- Common pattern transformations

## Implementation Plan

### Phase 1: Analysis and Documentation

1. Audit all current ESLint rules and codemods
2. Document exact overlap areas
3. Measure current maintenance burden
4. Create comparison matrix of capabilities

### Phase 2: Proof of Concept

1. Create shared utility functions for common patterns
2. Implement one rule/codemod consolidation as test case
3. Measure performance and workflow impact
4. Gather feedback on developer experience

### Phase 3: Decision and Roadmap

1. Choose consolidation approach based on PoC results
2. Create migration plan for existing rules/codemods
3. Update automation-approaches rule with new guidelines
4. Plan rollout strategy

## Success Criteria

- [ ] Clear decision matrix for when to use ESLint vs codemods
- [ ] Reduced maintenance burden for automated fixes
- [ ] Improved developer experience with unified approach
- [ ] Better alignment with automation-approaches rule
- [ ] Maintained or improved fix reliability and performance
- [ ] Updated documentation and best practices

## Implementation Considerations

### Follow Established Patterns

- Adhere to automation-approaches rule (AST-based, root cause focus)
- Follow Task #178 codemod best practices
- Maintain variable-naming-protocol compliance

### Safety and Reliability

- Ensure consolidated approach maintains current fix reliability
- Preserve syntax safety guarantees
- Maintain error handling and rollback capabilities

### Developer Experience

- Preserve editor integration benefits
- Maintain real-time feedback capabilities
- Ensure smooth workflow integration

## References

- automation-approaches rule: AST-based approaches, root cause focus
- Task #178: Codemod best practices and standards
- variable-naming-protocol: Critical variable naming requirements
- Current ESLint configuration: `eslint.config.js`
- Existing codemod infrastructure: `codemods/` directory

## Next Steps

1. Create subtasks for each investigation area
2. Begin with analysis phase to understand current state
3. Implement proof of concept for highest-overlap area
4. Make data-driven decision on consolidation approach


## Requirements

[To be filled in]

## Success Criteria

[To be filled in]
