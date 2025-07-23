# Session Lint Command Analysis

## Executive Summary

This document provides a comprehensive analysis for adding a `session lint` command to the Minsky workflow tool. The command would perform pre-commit validation checks within session workspaces to catch issues early in the development workflow.

## Current State Analysis

### Existing Linting Infrastructure

**Current Tools:**
- ESLint with TypeScript plugin and custom rules
- Prettier for code formatting
- TypeScript compiler for type checking
- Custom variable naming checker
- Husky pre-commit hooks with lint-staged

**Current Pre-commit Workflow:**
```bash
# .husky/pre-commit flow:
1. Variable naming checker (custom script)
2. ESLint with --quiet flag (errors only)
3. Success/failure feedback
```

**Existing Scripts:**
- `npm run lint` - ESLint for entire codebase
- `npm run lint:fix` - Auto-fix ESLint issues
- `npm run format` - Prettier formatting
- Custom variable naming validation

### Session Architecture Analysis

**Current Session Commands:**
- `session start` - Create new session workspace
- `session list` - List all sessions
- `session get` - Get session details
- `session dir` - Get session directory
- `session delete` - Remove session
- `session update` - Sync with main branch
- `session approve` - Approve and merge PR
- `session pr` - Create pull request
- `session commit` - Commit and push changes

**Session Context:**
- Sessions operate in isolated workspace directories
- Each session has its own git branch
- Sessions are associated with specific tasks
- Complete project clone with dependencies installed

### Identified Pain Points

1. **Late Error Discovery**: Issues often found during PR creation or CI
2. **Inconsistent Validation**: No standardized pre-commit checks for sessions
3. **Manual Process**: Developers must remember to run linting manually
4. **Context Switching**: Need to leave session workspace to run comprehensive checks
5. **Performance**: Full project linting can be slow for large codebases

## Research Findings

### Use Cases Identified

#### 1. Pre-commit Validation
- Developer wants to check code quality before committing
- Quick feedback loop for immediate issue resolution
- Confidence in code quality before sharing

#### 2. Session Health Check
- Verify session workspace integrity
- Check for common configuration issues
- Validate git status and branch state

#### 3. PR Preparation
- Comprehensive check before creating pull request
- Ensure all requirements are met
- Reduce back-and-forth during code review

#### 4. CI/CD Pipeline Preview
- Simulate what CI will check locally
- Catch issues before pushing to remote
- Reduce failed CI builds

### Existing Tool Analysis

#### ESLint Integration
**Strengths:**
- Already configured with TypeScript support
- Custom rules for project-specific patterns
- Fast incremental checking
- Auto-fix capabilities

**Integration Strategy:**
- Respect existing .eslintrc.json configuration
- Support incremental checking (changed files only)
- Preserve custom rules (variable naming, etc.)

#### TypeScript Compiler
**Capabilities:**
- Type checking and compilation validation
- Import/export validation
- Comprehensive error reporting

**Integration Points:**
- Use `tsc --noEmit` for type checking only
- Leverage existing tsconfig.json
- Support incremental compilation

#### Pre-commit Hook Analysis
**Current Implementation:**
- Variable naming validation
- ESLint with error-only reporting
- Simple pass/fail feedback

**Enhancement Opportunities:**
- More comprehensive checking
- Better error reporting and guidance
- Performance optimization
- Extensibility for custom checks

### Performance Considerations

#### Benchmark Analysis
**Current Performance:**
- Full ESLint: ~5-15 seconds (depends on codebase size)
- TypeScript check: ~3-8 seconds
- Custom scripts: ~1-2 seconds

**Optimization Strategies:**
1. **Incremental Checking**: Only validate changed files
2. **Parallel Execution**: Run checks concurrently
3. **Caching**: Leverage ESLint and TSC caching
4. **Smart Skipping**: Skip checks when not needed

#### Implementation Approach
- Use file modification timestamps for incremental checks
- Implement concurrent check execution with Promise.all
- Leverage existing tool caching mechanisms
- Provide fast vs comprehensive check modes

### Integration Architecture

#### Command Interface Design
```typescript
// Proposed command structure
minsky session lint [options]

// Options:
--fix          Auto-fix issues where possible
--fast         Run only fast checks (skip slow validations)  
--json         Output results in JSON format
--verbose      Show detailed output and timing
--changed      Only check changed files since last commit
--quiet        Suppress warnings, show only errors
--config       Path to custom lint configuration
```

#### Check Categories

1. **Code Quality Checks**
   - ESLint validation
   - TypeScript compilation
   - Custom rule validation

2. **Project Structure Checks**
   - Import/export validation
   - File naming conventions
   - Directory structure compliance

3. **Git Status Checks**
   - Uncommitted changes detection
   - Branch status validation
   - Merge conflict detection

4. **Dependency Checks**
   - Package.json validation
   - Dependency version conflicts
   - Missing dependencies

5. **Test Validation**
   - Test file syntax validation
   - Test naming conventions
   - Missing test coverage (basic)

#### Error Reporting Strategy

**Human-Readable Output:**
```
🔍 Minsky Session Lint Results

✅ TypeScript Compilation     (2.3s)
✅ ESLint Validation         (1.8s)
❌ Import/Export Validation  (0.5s)
  
❌ 3 errors found:
  
src/commands/session-lint.ts:42:15
  Error: Cannot find module './non-existent-module'
  
src/domain/validation.ts:18:1
  Error: Circular dependency detected
  
Performance: 4.6s total, 15 files checked
```

**JSON Output:**
```json
{
  "success": false,
  "summary": {
    "totalTime": 4600,
    "filesChecked": 15,
    "errors": 3,
    "warnings": 0
  },
  "checks": [
    {
      "name": "typescript",
      "status": "passed",
      "duration": 2300
    },
    {
      "name": "eslint", 
      "status": "passed",
      "duration": 1800
    },
    {
      "name": "imports",
      "status": "failed",
      "duration": 500,
      "errors": [
        {
          "file": "src/commands/session-lint.ts",
          "line": 42,
          "column": 15,
          "message": "Cannot find module './non-existent-module'",
          "rule": "import-validation"
        }
      ]
    }
  ]
}
```

## Design Proposal

### Command Architecture

#### Core Components

1. **Lint Command Handler**
   - Parse command options
   - Coordinate check execution
   - Format and display results

2. **Check Registry**
   - Pluggable check system
   - Allow custom checks
   - Manage check dependencies and ordering

3. **File System Analyzer**
   - Detect changed files
   - Build file dependency graph
   - Support incremental validation

4. **Result Aggregator**
   - Collect results from all checks
   - Format output (human/JSON)
   - Generate performance metrics

#### Check Implementation

**Base Check Interface:**
```typescript
interface LintCheck {
  name: string;
  description: string;
  category: 'code' | 'structure' | 'git' | 'deps' | 'tests';
  
  // Check if this validation should run
  shouldRun(context: LintContext): Promise<boolean>;
  
  // Execute the validation
  execute(context: LintContext): Promise<LintResult>;
  
  // Auto-fix capability
  canFix: boolean;
  fix?(context: LintContext): Promise<FixResult>;
}
```

**Built-in Checks:**

1. **TypeScriptCheck**
   - Uses `tsc --noEmit` for type validation
   - Leverages incremental compilation
   - Reports type errors with file/line context

2. **ESLintCheck**
   - Integrates with existing ESLint configuration
   - Supports auto-fix with `--fix` option
   - Incremental checking for performance

3. **ImportExportCheck**
   - Validates import paths and module resolution
   - Detects circular dependencies
   - Checks for unused imports

4. **GitStatusCheck**
   - Validates branch state
   - Checks for uncommitted changes
   - Detects merge conflicts

5. **ProjectStructureCheck**
   - Validates file naming conventions
   - Checks directory structure compliance
   - Ensures required files exist

### Integration Strategy

#### Session Command Integration

**Add to existing session commands:**
```typescript
// In src/adapters/shared/commands/session.ts
sharedCommandRegistry.registerCommand({
  id: "session.lint",
  category: CommandCategory.SESSION,
  name: "lint",
  description: "Run comprehensive linting and validation checks",
  parameters: sessionLintCommandParams,
  execute: sessionLintExecute
});
```

**Domain Layer Integration:**
```typescript
// In src/domain/session/session-commands.ts
export async function sessionLint(params: SessionLintParams): Promise<LintResults> {
  // Implementation
}
```

#### Configuration Management

**Default Configuration:**
- Use existing .eslintrc.json
- Respect existing tsconfig.json
- Follow existing pre-commit patterns

**Custom Configuration:**
```json
// .minsky-lint.json (optional)
{
  "checks": {
    "typescript": { "enabled": true },
    "eslint": { "enabled": true, "autoFix": false },
    "imports": { "enabled": true },
    "git": { "enabled": true },
    "structure": { "enabled": false }
  },
  "performance": {
    "maxDuration": 30000,
    "enableCaching": true,
    "incrementalMode": true
  },
  "output": {
    "format": "human",
    "verbose": false,
    "showTiming": true
  }
}
```

### Implementation Plan

#### Phase 1: Core Infrastructure (Week 1)
1. **Command Registration**
   - Add session.lint command to shared registry
   - Implement basic parameter parsing
   - Set up domain layer entry point

2. **Check Framework**
   - Design and implement base LintCheck interface
   - Create check registry system
   - Implement result aggregation

3. **Basic Checks**
   - TypeScript compilation check
   - ESLint integration check
   - Basic git status validation

#### Phase 2: Enhanced Validation (Week 2)
1. **Advanced Checks**
   - Import/export validation
   - Project structure validation
   - Dependency validation

2. **Performance Optimization**
   - Implement incremental checking
   - Add parallel check execution
   - Implement caching strategy

3. **Auto-fix Integration**
   - ESLint auto-fix support
   - Basic structure auto-fixes
   - Import organization

#### Phase 3: User Experience (Week 3)
1. **Output Formatting**
   - Human-readable error reporting
   - JSON output for tooling
   - Performance metrics

2. **Configuration System**
   - Custom configuration file support
   - CLI option parsing
   - Default configuration management

3. **Integration Testing**
   - Test with existing workflows
   - Performance benchmarking
   - User acceptance testing

### Risk Assessment

#### Technical Risks

1. **Performance Impact**
   - **Risk**: Slow linting could disrupt workflow
   - **Mitigation**: Incremental checking, parallel execution, caching

2. **Configuration Conflicts**
   - **Risk**: Custom configs might conflict with existing tools
   - **Mitigation**: Respect existing configurations, provide override options

3. **Dependency Issues**
   - **Risk**: Additional dependencies could cause conflicts
   - **Mitigation**: Minimize new dependencies, use existing tool APIs

#### User Experience Risks

1. **Workflow Disruption**
   - **Risk**: New command might change established patterns
   - **Mitigation**: Make command optional, integrate gradually

2. **Error Message Quality**
   - **Risk**: Poor error messages could frustrate users
   - **Mitigation**: Invest in clear, actionable error reporting

3. **Learning Curve**
   - **Risk**: Users might not adopt new command
   - **Mitigation**: Clear documentation, gradual rollout, training

### Success Metrics

#### Technical Metrics
- Command execution time < 10 seconds for typical session
- Error detection rate improvement (measure before/after)
- Reduced CI failure rate due to preventable issues

#### User Experience Metrics
- User adoption rate (command usage frequency)
- Developer satisfaction surveys
- Reduced time spent debugging pre-commit issues

#### Quality Metrics
- Reduction in PR review cycles due to code quality issues
- Improved code quality scores
- Faster development velocity

## Recommendations

### Go/No-Go Decision: **GO**

**Justification:**
1. **Clear User Value**: Addresses real pain points in development workflow
2. **Technical Feasibility**: Builds on existing infrastructure effectively
3. **Incremental Delivery**: Can be implemented in manageable phases
4. **Low Risk**: Minimal disruption to existing workflows

### Implementation Priorities

1. **Start with TypeScript + ESLint**: Build on existing, proven tools
2. **Focus on Performance**: Ensure command is fast enough for frequent use
3. **Iterative Approach**: Release basic version first, enhance based on feedback
4. **Documentation**: Invest heavily in clear documentation and examples

### Next Steps

1. **Prototype Development**: Build basic working implementation
2. **User Testing**: Get feedback from core developers
3. **Performance Benchmarking**: Measure against current workflow
4. **Documentation**: Create user guides and technical documentation
5. **Gradual Rollout**: Optional use first, then integrate into recommended workflow

---

*This analysis represents a comprehensive evaluation of the session lint command proposal. The recommendation is to proceed with implementation using the phased approach outlined above.*