# Codemods Directory

This directory contains automated code transformation tools for the Minsky project. All codemods follow evidence-based standards prioritizing AST-based approaches over regex alternatives.

## Standards and Guidelines

**Primary Rule**: See [.cursor/rules/codemod-development-standards.mdc](../.cursor/rules/codemod-development-standards.mdc) for comprehensive development standards.

**Core Principle**: **AST-FIRST DEVELOPMENT** - Always evaluate AST-based solutions before regex alternatives.

## Effectiveness Evidence

**Task #166 Proof**: AST-based approaches are **6x more effective** than regex approaches:
- **AST-based fix-variable-naming-ast.ts**: 231 fixes, 100% success rate, zero syntax errors
- **Regex-based approaches**: High syntax error rates, complex pattern matching, frequent failures

## Directory Structure

```
codemods/
├── README.md                    # This file
├── fix-variable-naming-ast.ts   # Gold standard AST-based codemod
├── comprehensive-underscore-fix.ts
├── simple-underscore-fix.ts
├── eliminate-ts2322-completely.ts
├── [... 90+ other codemods]
└── __tests__/                   # Test files for codemods
    ├── fixtures/
    │   ├── input/
    │   └── expected/
    └── *.test.ts
```

## Codemod Categories (By Effectiveness)

### HIGH EFFECTIVENESS: AST-Based Transformations ⭐
**Recommended for all new development**

**Characteristics**:
- Uses `ts-morph` or TypeScript Compiler API
- Syntax-aware transformations
- Built-in validation and error handling
- 95%+ success rates with zero syntax errors

**Examples**:
- `fix-variable-naming-ast.ts` - **Gold Standard** (231 fixes, 100% success)
- `comprehensive-underscore-fix.ts` - AST-based underscore removal
- `eliminate-ts2322-completely.ts` - Type-aware error fixing

### MEDIUM EFFECTIVENESS: ESLint Output Parsing
**Acceptable for specific use cases**

**Characteristics**:
- Parses ESLint output for targeted fixes
- More reliable than pure regex
- Limited to ESLint-detectable patterns

**Examples**:
- `simple-underscore-fix.ts` - ESLint-guided underscore fixes
- Various ESLint-based error fixers

### LOW EFFECTIVENESS: Simple Regex (Migration Priority)
**Should be migrated to AST approaches**

**Characteristics**:
- Simple string replacements
- Basic pattern matching
- Higher error rates than AST approaches

**Migration Target**: Convert to AST-based equivalents using migration guide.

### DEPRECATED: Complex Pattern-Specific Regex (Anti-Patterns)
**Should be replaced immediately**

**Characteristics**:
- Complex regex patterns with high failure rates
- Multi-step text manipulations
- Syntax-unaware transformations

**Action Required**: Replace with AST-based implementations.

## Usage Guidelines

### Running Codemods

```bash
# Make executable
chmod +x codemods/fix-variable-naming-ast.ts

# Run directly
./codemods/fix-variable-naming-ast.ts

# Or with bun
bun run codemods/fix-variable-naming-ast.ts
```

### Development Workflow

1. **Analyze Requirements**: Determine if AST approach is suitable
2. **Design Transformation**: Use decision trees from standards
3. **Implement Following Standards**: Use modular design patterns
4. **Test Thoroughly**: Include unit, integration, and edge case tests
5. **Document Completely**: Provide usage examples and performance metrics

### Required Code Structure

All new codemods must follow this structure:

```typescript
interface CodemodIssue {
  file: string;
  line: number;
  column: number;
  description: string;
  severity: "error" | "warning" | "info";
  context: string;
}

class CodemodName {
  private project: Project;
  private issues: CodemodIssue[] = [];
  private metrics: CodemodMetrics = { /* ... */ };

  constructor() {
    this.project = new Project();
  }

  addSourceFiles(patterns: string[]): void { /* ... */ }
  findIssues(): CodemodIssue[] { /* ... */ }
  fixIssues(): void { /* ... */ }
  generateReport(): void { /* ... */ }
  execute(patterns: string[]): Promise<void> { /* ... */ }
}
```

## Migration Guide: Regex to AST

### Identification Phase

Look for codemods using:
- `String.prototype.replace()`
- Complex regular expressions
- Multi-step text manipulation
- High error rates or syntax issues

### Assessment Phase

**Questions to Ask**:
- What syntactic structure is being changed?
- Are type relationships involved?
- Does the change affect code semantics?
- How often does the current approach fail?

### Implementation Phase

1. **Map regex patterns to AST node types**
2. **Use ts-morph methods for traversal**
3. **Implement proper error handling**
4. **Add comprehensive testing**
5. **Validate transformation safety**

### Validation Phase

- Compare outputs with original regex approach
- Ensure no syntax errors introduced
- Verify semantic preservation
- Measure performance improvements

## Performance Targets

**Based on Task #166 Evidence**:
- **Target**: 95%+ success rate (match AST gold standard)
- **Requirement**: Zero syntax errors introduced
- **Benchmark**: Process 200+ files in under 5 seconds
- **Safety**: Comprehensive error handling and recovery

## Review and Approval Process

### Pre-Merge Checklist

**MANDATORY VERIFICATION**:
- [ ] Uses AST-based approach (or justified exception documented)
- [ ] Includes comprehensive error handling
- [ ] Has complete test coverage (unit, integration, edge cases)
- [ ] Follows modular design patterns
- [ ] Includes performance monitoring and reporting
- [ ] Provides clear documentation and usage examples

### Exception Policy

**REGEX EXCEPTIONS** require explicit justification:
- Document why AST approach is not suitable
- Provide evidence of safety and effectiveness
- Include comprehensive test coverage
- Get approval from codebase maintainers

## Common Patterns (Evidence-Based)

### 1. Variable Naming Fix (Gold Standard)
**FROM fix-variable-naming-ast.ts** (231 fixes, 100% success):

```typescript
const parameters = func.getParameters();
parameters.forEach(param => {
  const paramName = param.getName();
  if (paramName.startsWith("_")) {
    const newName = paramName.substring(1);
    param.rename(newName);
  }
});
```

### 2. Import Statement Transformation

```typescript
sourceFile.getImportDeclarations().forEach(importDecl => {
  const moduleSpecifier = importDecl.getModuleSpecifierValue();
  if (moduleSpecifier.startsWith("./old-path")) {
    importDecl.setModuleSpecifier(
      moduleSpecifier.replace("./old-path", "./new-path")
    );
  }
});
```

### 3. Function Signature Updates

```typescript
const functions = sourceFile.getFunctions();
functions.forEach(func => {
  const params = func.getParameters();
  params.forEach(param => {
    if (param.getTypeNode()) {
      // Safe AST transformation with type awareness
    }
  });
});
```

## Testing Standards

### Required Test Coverage

All codemods must include:
- **Unit tests**: Individual transformation functions
- **Integration tests**: Full codemod execution
- **Edge case tests**: Boundary conditions and error scenarios
- **Performance benchmarks**: Processing time and success rates

### Test Structure

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

## Contributing

### New Codemod Development

1. **Analyze requirement**: Determine if AST approach is suitable
2. **Design transformation**: Use decision trees and established patterns
3. **Implement with standards**: Follow modular design guidelines
4. **Test thoroughly**: Include all required test types
5. **Document completely**: Provide usage and performance information

### Existing Codemod Migration

1. **Assess current approach**: Identify regex vs AST usage
2. **Plan migration**: Use migration guide steps
3. **Implement incrementally**: Test each transformation step
4. **Validate equivalence**: Ensure same outcomes with better safety
5. **Performance comparison**: Document improvements

## Continuous Improvement

### Feedback Loop

1. **Monitor effectiveness**: Track success rates and error patterns
2. **Update standards**: Incorporate new evidence and best practices
3. **Migrate legacy codemods**: Gradually replace regex with AST approaches
4. **Document lessons learned**: Update guidelines with new evidence

### Success Metrics

- **Effectiveness**: Percentage of successful transformations
- **Safety**: Number of syntax errors introduced (target: 0)
- **Performance**: Processing time per file
- **Maintainability**: Code complexity and readability scores

## Support and Resources

- **Standards Documentation**: [.cursor/rules/codemod-development-standards.mdc](../.cursor/rules/codemod-development-standards.mdc)
- **Development Guidelines**: [docs/codemod-development-guidelines.md](../docs/codemod-development-guidelines.md)
- **Analysis Report**: [docs/codemod-analysis.md](../docs/codemod-analysis.md)
- **Working Examples**: [examples/variable-naming-example.ts](../examples/variable-naming-example.ts)

## Conclusion

This directory represents a systematic approach to code transformation based on concrete evidence from Task #166. By following AST-first development principles, we ensure codemods are reliable, maintainable, and effective at scale.

The 6x effectiveness improvement demonstrated by AST approaches makes adherence to these standards essential for the project's long-term success. 
