# Session Lint Command - Design Specification

## Overview

This document provides detailed technical specifications for implementing the `minsky session lint` command, a comprehensive pre-commit validation tool for session workspaces.

## Technical Architecture

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLI Interface                             │
│  minsky session lint [--fix] [--fast] [--json] [--verbose]     │
└─────────────────────┬───────────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────────┐
│                 Session Lint Controller                         │
│  • Parse CLI options                                            │
│  • Resolve session context                                      │
│  • Coordinate check execution                                   │
│  • Format and return results                                    │
└─────────────────────┬───────────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────────┐
│                   Check Registry                                │
│  • Manage available checks                                      │
│  • Handle check dependencies                                    │
│  • Execute checks in parallel/series                            │
└─────────────────────┬───────────────────────────────────────────┘
                      │
       ┌──────────────┼──────────────┬──────────────┬─────────────┐
       │              │              │              │             │
┌──────▼──┐  ┌────────▼─┐  ┌─────────▼─┐  ┌─────────▼─┐  ┌───────▼──┐
│TypeScript│  │  ESLint  │  │  Import/  │  │Git Status│  │Structure │
│  Check   │  │  Check   │  │Export Chk │  │  Check   │  │  Check   │
└──────────┘  └──────────┘  └───────────┘  └──────────┘  └──────────┘
```

### Core Components

#### 1. Session Lint Controller

**Responsibility**: Main orchestration and interface

**Location**: `src/domain/session/session-lint-controller.ts`

```typescript
export interface SessionLintParams {
  fix?: boolean;
  fast?: boolean;
  json?: boolean;
  verbose?: boolean;
  changed?: boolean;
  quiet?: boolean;
  config?: string;
}

export interface SessionLintResult {
  success: boolean;
  summary: {
    totalTime: number;
    filesChecked: number;
    errors: number;
    warnings: number;
    fixed: number;
  };
  checks: CheckResult[];
  performance: PerformanceMetrics;
}

export class SessionLintController {
  constructor(
    private checkRegistry: CheckRegistry,
    private fileAnalyzer: FileAnalyzer,
    private configManager: LintConfigManager
  ) {}

  async lint(params: SessionLintParams): Promise<SessionLintResult> {
    // Implementation
  }
}
```

#### 2. Check Registry

**Responsibility**: Manage and execute validation checks

**Location**: `src/domain/session/lint/check-registry.ts`

```typescript
export interface LintCheck {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: CheckCategory;
  readonly canFix: boolean;
  readonly dependencies: string[];

  shouldRun(context: LintContext): Promise<boolean>;
  execute(context: LintContext): Promise<CheckResult>;
  fix?(context: LintContext, issues: LintIssue[]): Promise<FixResult>;
}

export enum CheckCategory {
  CODE = 'code',
  STRUCTURE = 'structure', 
  GIT = 'git',
  DEPENDENCIES = 'deps',
  TESTS = 'tests'
}

export class CheckRegistry {
  private checks = new Map<string, LintCheck>();
  
  register(check: LintCheck): void;
  getChecks(category?: CheckCategory): LintCheck[];
  executeChecks(context: LintContext, options: ExecutionOptions): Promise<CheckResult[]>;
}
```

#### 3. File Analyzer

**Responsibility**: Analyze files and detect changes

**Location**: `src/domain/session/lint/file-analyzer.ts`

```typescript
export interface FileAnalysisResult {
  changedFiles: string[];
  allFiles: string[];
  dependencies: Map<string, string[]>;
  gitStatus: GitFileStatus[];
}

export class FileAnalyzer {
  constructor(private workspaceRoot: string) {}

  async analyzeChanges(since?: string): Promise<FileAnalysisResult>;
  async buildDependencyGraph(files: string[]): Promise<Map<string, string[]>>;
  async getRelevantFiles(changedFiles: string[]): Promise<string[]>;
}
```

### Built-in Checks Implementation

#### 1. TypeScript Compilation Check

**Location**: `src/domain/session/lint/checks/typescript-check.ts`

```typescript
export class TypeScriptCheck implements LintCheck {
  readonly id = 'typescript';
  readonly name = 'TypeScript Compilation';
  readonly description = 'Validates TypeScript compilation and type checking';
  readonly category = CheckCategory.CODE;
  readonly canFix = false;
  readonly dependencies: string[] = [];

  async shouldRun(context: LintContext): Promise<boolean> {
    // Check if TypeScript files exist
    return context.files.some(f => f.endsWith('.ts') || f.endsWith('.tsx'));
  }

  async execute(context: LintContext): Promise<CheckResult> {
    const startTime = Date.now();
    
    try {
      // Use TypeScript compiler API for validation
      const result = await this.runTypeScriptCompiler(context);
      
      return {
        checkId: this.id,
        status: result.errors.length === 0 ? 'passed' : 'failed',
        duration: Date.now() - startTime,
        errors: result.errors,
        warnings: result.warnings,
        filesChecked: result.filesChecked
      };
    } catch (error) {
      return {
        checkId: this.id,
        status: 'error',
        duration: Date.now() - startTime,
        errors: [this.createErrorFromException(error)],
        warnings: [],
        filesChecked: 0
      };
    }
  }

  private async runTypeScriptCompiler(context: LintContext): Promise<TsCompilerResult> {
    // Implementation using TypeScript compiler API
    // Leverage existing tsconfig.json
    // Support incremental compilation
  }
}
```

#### 2. ESLint Integration Check

**Location**: `src/domain/session/lint/checks/eslint-check.ts`

```typescript
export class ESLintCheck implements LintCheck {
  readonly id = 'eslint';
  readonly name = 'ESLint Validation';
  readonly description = 'Runs ESLint validation with auto-fix support';
  readonly category = CheckCategory.CODE;
  readonly canFix = true;
  readonly dependencies: string[] = [];

  async execute(context: LintContext): Promise<CheckResult> {
    const { ESLint } = await import('eslint');
    
    const eslint = new ESLint({
      cwd: context.workspaceRoot,
      fix: context.options.fix && this.canFix
    });

    const results = await eslint.lintFiles(
      context.options.changed ? context.changedFiles : ['src/**/*.ts', 'src/**/*.js']
    );

    if (context.options.fix && this.canFix) {
      await ESLint.outputFixes(results);
    }

    return this.formatESLintResults(results);
  }

  async fix(context: LintContext, issues: LintIssue[]): Promise<FixResult> {
    // ESLint auto-fix implementation
  }
}
```

#### 3. Import/Export Validation Check

**Location**: `src/domain/session/lint/checks/import-export-check.ts`

```typescript
export class ImportExportCheck implements LintCheck {
  readonly id = 'imports';
  readonly name = 'Import/Export Validation';
  readonly description = 'Validates import paths and detects circular dependencies';
  readonly category = CheckCategory.STRUCTURE;
  readonly canFix = true;
  readonly dependencies: string[] = [];

  async execute(context: LintContext): Promise<CheckResult> {
    const issues: LintIssue[] = [];
    
    // Check for missing imports
    issues.push(...await this.checkMissingImports(context.files));
    
    // Check for circular dependencies
    issues.push(...await this.checkCircularDependencies(context.dependencyGraph));
    
    // Check for unused imports
    issues.push(...await this.checkUnusedImports(context.files));

    return {
      checkId: this.id,
      status: issues.length === 0 ? 'passed' : 'failed',
      duration: Date.now() - context.startTime,
      errors: issues.filter(i => i.severity === 'error'),
      warnings: issues.filter(i => i.severity === 'warning'),
      filesChecked: context.files.length
    };
  }

  private async checkMissingImports(files: string[]): Promise<LintIssue[]> {
    // Use TypeScript compiler API to resolve imports
    // Check if import paths are valid
  }

  private async checkCircularDependencies(dependencyGraph: Map<string, string[]>): Promise<LintIssue[]> {
    // Implement cycle detection algorithm
    // Report circular dependency chains
  }

  private async checkUnusedImports(files: string[]): Promise<LintIssue[]> {
    // Parse AST to find unused imports
    // Report unused import statements
  }

  async fix(context: LintContext, issues: LintIssue[]): Promise<FixResult> {
    // Auto-remove unused imports
    // Auto-organize imports
  }
}
```

#### 4. Git Status Check

**Location**: `src/domain/session/lint/checks/git-status-check.ts`

```typescript
export class GitStatusCheck implements LintCheck {
  readonly id = 'git';
  readonly name = 'Git Status Validation';
  readonly description = 'Validates git repository status and branch state';
  readonly category = CheckCategory.GIT;
  readonly canFix = false;
  readonly dependencies: string[] = [];

  async execute(context: LintContext): Promise<CheckResult> {
    const issues: LintIssue[] = [];
    
    // Check for uncommitted changes
    const status = await this.getGitStatus(context.workspaceRoot);
    if (status.hasUncommittedChanges && !context.options.allowDirty) {
      issues.push({
        severity: 'warning',
        message: 'Repository has uncommitted changes',
        file: '',
        line: 0,
        column: 0,
        rule: 'git-uncommitted-changes'
      });
    }

    // Check for merge conflicts
    const conflicts = await this.checkMergeConflicts(context.workspaceRoot);
    issues.push(...conflicts);

    // Validate branch state
    const branchIssues = await this.validateBranch(context.workspaceRoot);
    issues.push(...branchIssues);

    return this.formatCheckResult(issues);
  }

  private async getGitStatus(workspaceRoot: string): Promise<GitStatus> {
    // Execute git status and parse output
  }

  private async checkMergeConflicts(workspaceRoot: string): Promise<LintIssue[]> {
    // Check for merge conflict markers in files
  }

  private async validateBranch(workspaceRoot: string): Promise<LintIssue[]> {
    // Validate current branch against expected session branch
  }
}
```

### Command Interface Implementation

#### CLI Adapter Integration

**Location**: `src/adapters/shared/commands/session.ts` (addition)

```typescript
// Add to existing registerSessionCommands function
sharedCommandRegistry.registerCommand({
  id: "session.lint",
  category: CommandCategory.SESSION,
  name: "lint",
  description: "Run comprehensive linting and validation checks",
  parameters: sessionLintCommandParams,
  execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
    log.debug("Executing session.lint command", { params, context });

    try {
      // Resolve session context
      const sessionContext = await resolveSessionContextWithFeedback({
        session: params.sessionName,
        task: params.task,
        allowAutoDetection: true,
      });

      // Execute lint command
      const result = await sessionLint({
        sessionName: sessionContext.sessionName,
        fix: params.fix,
        fast: params.fast,
        json: params.json,
        verbose: params.verbose,
        changed: params.changed,
        quiet: params.quiet,
        config: params.config,
      });

      return {
        success: result.success,
        result,
      };
    } catch (error) {
      log.error("Failed to lint session", {
        error: getErrorMessage(error as Error),
        sessionName: params.sessionName,
      });
      throw error;
    }
  },
});
```

#### Parameter Schema

**Location**: `src/adapters/shared/commands/session-parameters.ts` (addition)

```typescript
export const sessionLintCommandParams = {
  sessionName: {
    schema: z.string().min(1),
    description: "Session identifier (name or task ID)",
    required: false,
  },
  fix: {
    schema: z.boolean().default(false),
    description: "Auto-fix issues where possible",
    required: false,
  },
  fast: {
    schema: z.boolean().default(false),
    description: "Run only fast checks (skip slow validations)",
    required: false,
  },
  json: {
    schema: z.boolean().default(false),
    description: "Output results in JSON format",
    required: false,
  },
  verbose: {
    schema: z.boolean().default(false),
    description: "Show detailed output and timing information",
    required: false,
  },
  changed: {
    schema: z.boolean().default(false),
    description: "Only check files changed since last commit",
    required: false,
  },
  quiet: {
    schema: z.boolean().default(false),
    description: "Suppress warnings, show only errors",
    required: false,
  },
  config: {
    schema: z.string(),
    description: "Path to custom lint configuration file",
    required: false,
  },
};
```

### Domain Layer Implementation

#### Main Session Lint Function

**Location**: `src/domain/session/session-commands.ts` (addition)

```typescript
export async function sessionLint(
  params: SessionLintParams,
  deps?: {
    sessionProvider?: SessionProviderInterface;
    workspaceUtils?: WorkspaceUtilsInterface;
  }
): Promise<SessionLintResult> {
  const dependencies = {
    sessionProvider: deps?.sessionProvider || createSessionProvider(),
    workspaceUtils: deps?.workspaceUtils || createWorkspaceUtils(),
  };

  // Resolve session context
  const sessionContext = await resolveSessionContextWithFeedback({
    session: params.sessionName,
    allowAutoDetection: true,
    sessionProvider: dependencies.sessionProvider,
  });

  // Get session workspace directory
  const sessionDir = await dependencies.sessionProvider.getSessionWorkdir(
    sessionContext.sessionName
  );

  // Initialize lint controller
  const controller = new SessionLintController(
    new CheckRegistry(),
    new FileAnalyzer(sessionDir),
    new LintConfigManager(sessionDir)
  );

  // Register built-in checks
  await controller.registerBuiltInChecks();

  // Execute linting
  const result = await controller.lint({
    workspaceRoot: sessionDir,
    ...params,
  });

  return result;
}
```

### Configuration Management

#### Configuration Schema

**Location**: `src/domain/session/lint/config/lint-config.ts`

```typescript
export interface LintConfiguration {
  checks: {
    [checkId: string]: {
      enabled: boolean;
      options?: Record<string, any>;
    };
  };
  performance: {
    maxDuration: number;
    enableCaching: boolean;
    incrementalMode: boolean;
    parallelChecks: boolean;
  };
  output: {
    format: 'human' | 'json';
    verbose: boolean;
    showTiming: boolean;
    colorOutput: boolean;
  };
  files: {
    include: string[];
    exclude: string[];
    ignoreGitignore: boolean;
  };
}

export const defaultLintConfiguration: LintConfiguration = {
  checks: {
    typescript: { enabled: true },
    eslint: { enabled: true, options: { autoFix: false } },
    imports: { enabled: true },
    git: { enabled: true },
    structure: { enabled: true },
  },
  performance: {
    maxDuration: 30000,
    enableCaching: true,
    incrementalMode: true,
    parallelChecks: true,
  },
  output: {
    format: 'human',
    verbose: false,
    showTiming: true,
    colorOutput: true,
  },
  files: {
    include: ['src/**/*.ts', 'src/**/*.js'],
    exclude: ['node_modules/**', 'dist/**', 'build/**'],
    ignoreGitignore: true,
  },
};
```

#### Configuration Manager

```typescript
export class LintConfigManager {
  constructor(private workspaceRoot: string) {}

  async loadConfiguration(configPath?: string): Promise<LintConfiguration> {
    // Load from custom path or default locations
    const configFile = configPath || await this.findConfigFile();
    
    if (configFile && existsSync(configFile)) {
      const userConfig = await this.parseConfigFile(configFile);
      return this.mergeConfigurations(defaultLintConfiguration, userConfig);
    }

    return defaultLintConfiguration;
  }

  private async findConfigFile(): Promise<string | null> {
    const candidates = [
      '.minsky-lint.json',
      '.minsky-lint.js',
      'minsky-lint.config.js',
    ];

    for (const candidate of candidates) {
      const path = join(this.workspaceRoot, candidate);
      if (existsSync(path)) {
        return path;
      }
    }

    return null;
  }
}
```

### Output Formatting

#### Human-Readable Formatter

**Location**: `src/domain/session/lint/formatters/human-formatter.ts`

```typescript
export class HumanFormatter {
  format(result: SessionLintResult, options: FormatOptions): string {
    const output: string[] = [];
    
    // Header
    output.push('🔍 Minsky Session Lint Results\n');

    // Check results summary
    for (const check of result.checks) {
      const icon = check.status === 'passed' ? '✅' : '❌';
      const timing = options.showTiming ? ` (${check.duration}ms)` : '';
      output.push(`${icon} ${check.name}${timing}`);
    }

    // Error details
    if (result.summary.errors > 0) {
      output.push(`\n❌ ${result.summary.errors} errors found:\n`);
      
      for (const check of result.checks) {
        if (check.errors.length > 0) {
          for (const error of check.errors) {
            output.push(this.formatError(error));
          }
        }
      }
    }

    // Performance summary
    if (options.showTiming) {
      output.push(`\nPerformance: ${result.summary.totalTime}ms total, ${result.summary.filesChecked} files checked`);
    }

    return output.join('\n');
  }

  private formatError(error: LintIssue): string {
    if (error.file) {
      return `${error.file}:${error.line}:${error.column}\n  Error: ${error.message}\n`;
    }
    return `Error: ${error.message}\n`;
  }
}
```

#### JSON Formatter

**Location**: `src/domain/session/lint/formatters/json-formatter.ts`

```typescript
export class JsonFormatter {
  format(result: SessionLintResult): string {
    return JSON.stringify(result, null, 2);
  }
}
```

### Performance Optimization

#### Incremental Checking Strategy

1. **File Change Detection**
   - Use git diff to detect changed files
   - Track file modification timestamps
   - Build dependency graph for affected files

2. **Caching Mechanism**
   - Cache check results by file hash
   - Invalidate cache on file changes
   - Share cache across check types where possible

3. **Parallel Execution**
   - Run independent checks concurrently
   - Respect check dependencies
   - Limit concurrency based on system resources

#### Implementation Example

```typescript
export class PerformanceOptimizer {
  private cache = new Map<string, CachedResult>();

  async optimizeExecution(
    checks: LintCheck[],
    context: LintContext
  ): Promise<ExecutionPlan> {
    // Determine which checks can be cached
    const cacheable = await this.getCacheableChecks(checks, context);
    
    // Build execution dependency graph
    const dependencyGraph = this.buildDependencyGraph(checks);
    
    // Create parallel execution groups
    const executionGroups = this.createExecutionGroups(dependencyGraph);
    
    return {
      groups: executionGroups,
      cacheable,
      estimatedDuration: this.estimateDuration(executionGroups),
    };
  }
}
```

### Error Handling Strategy

#### Error Categories

1. **Check Execution Errors**: Failures in individual checks
2. **Configuration Errors**: Invalid configuration or missing dependencies
3. **System Errors**: File system, permission, or resource issues
4. **User Input Errors**: Invalid parameters or options

#### Error Recovery

```typescript
export class ErrorHandler {
  async handleCheckError(
    check: LintCheck,
    error: Error,
    context: LintContext
  ): Promise<CheckResult> {
    log.error(`Check ${check.id} failed`, { error: error.message });

    // Try to provide meaningful error messages
    if (error.message.includes('ENOENT')) {
      return this.createFileNotFoundError(check, error);
    }

    if (error.message.includes('permission')) {
      return this.createPermissionError(check, error);
    }

    // Generic error fallback
    return this.createGenericError(check, error);
  }

  private createFileNotFoundError(check: LintCheck, error: Error): CheckResult {
    return {
      checkId: check.id,
      status: 'error',
      duration: 0,
      errors: [{
        severity: 'error',
        message: `File not found: ${error.message}. Please check if all required files exist.`,
        file: '',
        line: 0,
        column: 0,
        rule: 'file-not-found'
      }],
      warnings: [],
      filesChecked: 0
    };
  }
}
```

### Testing Strategy

#### Unit Tests

**Test Coverage Requirements:**
- All check implementations: 90%+
- Core controller logic: 95%+
- Configuration management: 85%+
- Error handling: 90%+

#### Integration Tests

**Test Scenarios:**
- Full lint execution with real TypeScript/ESLint
- Performance benchmarks with large codebases
- Error handling with various failure conditions
- Configuration loading and merging

#### Test Implementation Example

```typescript
// src/domain/session/lint/__tests__/session-lint-controller.test.ts
describe('SessionLintController', () => {
  let controller: SessionLintController;
  let mockCheckRegistry: jest.Mocked<CheckRegistry>;
  let mockFileAnalyzer: jest.Mocked<FileAnalyzer>;

  beforeEach(() => {
    mockCheckRegistry = createMockCheckRegistry();
    mockFileAnalyzer = createMockFileAnalyzer();
    controller = new SessionLintController(
      mockCheckRegistry,
      mockFileAnalyzer,
      new LintConfigManager('/tmp/test')
    );
  });

  it('should execute all enabled checks', async () => {
    const result = await controller.lint({
      workspaceRoot: '/tmp/test',
      fix: false,
      fast: false,
    });

    expect(result.success).toBe(true);
    expect(result.checks).toHaveLength(5); // All built-in checks
    expect(mockCheckRegistry.executeChecks).toHaveBeenCalledTimes(1);
  });

  it('should handle check failures gracefully', async () => {
    mockCheckRegistry.executeChecks.mockRejectedValue(new Error('Check failed'));

    const result = await controller.lint({
      workspaceRoot: '/tmp/test',
    });

    expect(result.success).toBe(false);
    expect(result.summary.errors).toBeGreaterThan(0);
  });
});
```

### Documentation Requirements

#### User Documentation
- Command usage guide with examples
- Configuration file reference
- Troubleshooting guide
- Best practices and workflow integration

#### Developer Documentation
- Architecture overview
- Check development guide
- API reference
- Extension points documentation

---

This design specification provides a comprehensive blueprint for implementing the session lint command with proper architecture, error handling, performance optimization, and extensibility.