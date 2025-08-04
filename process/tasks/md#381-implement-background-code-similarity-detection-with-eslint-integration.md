# Task: Implement Background Code Similarity Detection with ESLint Integration

## Priority

**MEDIUM-HIGH** - Prevents accumulation of technical debt and code duplication

## Effort Estimate

**Large (10-14 hours)**

## Summary

Implement a background code similarity detection system that continuously analyzes the codebase for duplicate or overly similar functions, modules, and code units, surfacing findings through ESLint warnings to provide real-time feedback during development.

## Context

**Problem Discovered**: During Task #357 implementation, we discovered **FOUR DIFFERENT PR CREATION IMPLEMENTATIONS** across the codebase, indicating a systemic issue with code duplication detection and prevention.

**Root Cause**: No automated system exists to detect when similar functionality is being implemented multiple times, leading to:
- Maintenance overhead (fixing bugs in multiple places)
- Inconsistent behavior across similar functions
- Increased codebase complexity
- Wasted development effort reimplementing existing functionality

**Current State**: Manual discovery of duplication during code review or refactoring tasks, often too late to prevent the proliferation.

## Objectives

### Primary Goal

Implement a proactive code similarity detection system that identifies duplicate or overly similar code units and surfaces them as actionable warnings during development.

### Success Criteria

1. **Background Analysis**: Continuous monitoring of codebase for similarity patterns
2. **Real-time Feedback**: ESLint integration provides immediate warnings during development
3. **Actionable Results**: Clear identification of similar code with suggestions for consolidation
4. **Performance**: Minimal impact on development workflow and build times
5. **Configurability**: Adjustable similarity thresholds and exclusion patterns

## Technical Requirements

### 1. Background Similarity Analysis Engine

**Core Components**:

```typescript
interface SimilarityAnalyzer {
  analyzeCodebase(rootPath: string): Promise<SimilarityReport>;
  analyzeDiff(changedFiles: string[]): Promise<SimilarityReport>;
  compareCodeUnits(unit1: CodeUnit, unit2: CodeUnit): SimilarityScore;
}

interface CodeUnit {
  type: 'function' | 'class' | 'module' | 'component';
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  ast: ASTNode;
  tokens: Token[];
  metrics: CodeMetrics;
}

interface SimilarityScore {
  structural: number;    // AST structure similarity (0-1)
  textual: number;      // Token-based similarity (0-1)
  semantic: number;     // Semantic similarity (0-1)
  overall: number;      // Weighted combined score (0-1)
  confidence: number;   // Confidence in the similarity assessment
}
```

**Analysis Techniques**:

1. **AST-based Structural Analysis**: Compare Abstract Syntax Tree structures
2. **Token-based Analysis**: Compare normalized token sequences
3. **Semantic Analysis**: Compare variable/function naming patterns and purpose
4. **Metrics-based Analysis**: Compare cyclomatic complexity, LOC, parameter patterns

### 2. Similarity Database

**Schema Design**:

```sql
-- Core similarity findings
CREATE TABLE similarity_findings (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  status TEXT CHECK(status IN ('active', 'dismissed', 'resolved')) DEFAULT 'active',
  similarity_score REAL NOT NULL,
  confidence REAL NOT NULL
);

-- Code units involved in similarity
CREATE TABLE code_units (
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  unit_type TEXT NOT NULL,
  unit_name TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  metrics_json TEXT, -- JSON blob of code metrics
  last_modified TIMESTAMP NOT NULL
);

-- Many-to-many relationship between findings and code units
CREATE TABLE finding_code_units (
  finding_id TEXT REFERENCES similarity_findings(id),
  code_unit_id TEXT REFERENCES code_units(id),
  PRIMARY KEY (finding_id, code_unit_id)
);

-- Analysis metadata
CREATE TABLE analysis_runs (
  id TEXT PRIMARY KEY,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP,
  trigger_type TEXT, -- 'full', 'incremental', 'on-demand'
  files_analyzed INTEGER,
  units_analyzed INTEGER,
  findings_created INTEGER,
  findings_updated INTEGER
);
```

### 3. ESLint Rule Integration

**Custom ESLint Rule**:

```typescript
// eslint-plugin-similarity/rules/detect-similar-code.js
module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Detect similar code units that may be candidates for consolidation',
      category: 'Best Practices',
    },
    schema: [
      {
        type: 'object',
        properties: {
          threshold: { type: 'number', minimum: 0, maximum: 1 },
          dbPath: { type: 'string' },
          excludePatterns: { type: 'array', items: { type: 'string' } }
        },
        additionalProperties: false
      }
    ]
  },

  create(context) {
    const options = context.options[0] || {};
    const threshold = options.threshold || 0.7;
    const dbPath = options.dbPath || '.similarity/similarity.db';

    return {
      Program(node) {
        // Query similarity database for current file
        const findings = querySimilarityDB(context.getFilename(), dbPath);

        findings.forEach(finding => {
          if (finding.similarity_score >= threshold) {
            context.report({
              node,
              message: `Similar code detected (${Math.round(finding.similarity_score * 100)}% similarity): {{similar_units}}`,
              data: {
                similar_units: finding.similar_units.map(u => `${u.file_path}:${u.unit_name}`).join(', ')
              }
            });
          }
        });
      }
    };
  }
};
```

### 4. Background Process Architecture

**Process Options**:

**Option A: File System Watcher**
```typescript
class SimilarityWatcher {
  private watcher: chokidar.FSWatcher;
  private analyzer: SimilarityAnalyzer;
  private db: SimilarityDatabase;

  async start(rootPath: string) {
    this.watcher = chokidar.watch('**/*.{ts,js,tsx,jsx}', {
      cwd: rootPath,
      ignored: ['node_modules/**', '.git/**']
    });

    this.watcher.on('change', this.onFileChange.bind(this));
    this.watcher.on('add', this.onFileAdd.bind(this));
  }

  private async onFileChange(filePath: string) {
    // Incremental analysis of changed file
    await this.analyzer.analyzeDiff([filePath]);
  }
}
```

**Option B: Git Hook Integration**
```bash
#!/bin/sh
# .git/hooks/post-commit
npm run similarity:analyze-incremental
```

**Option C: Background Daemon**
```typescript
class SimilarityDaemon {
  private interval: NodeJS.Timeout;

  start(intervalMs = 300000) { // 5 minutes
    this.interval = setInterval(async () => {
      await this.runIncrementalAnalysis();
    }, intervalMs);
  }
}
```

### 5. Configuration System

**Configuration File** (`.similarity.config.js`):

```javascript
module.exports = {
  analysis: {
    thresholds: {
      structural: 0.8,
      textual: 0.7,
      semantic: 0.6,
      overall: 0.7
    },
    minLines: 10,          // Minimum lines for analysis
    maxLines: 1000,        // Maximum lines for analysis
    excludePatterns: [
      'test/**',
      '**/*.test.ts',
      'node_modules/**'
    ]
  },

  eslint: {
    enabled: true,
    warnThreshold: 0.7,
    errorThreshold: 0.9,
    dbPath: '.similarity/similarity.db'
  },

  background: {
    mode: 'watcher', // 'watcher' | 'daemon' | 'git-hooks'
    intervalMs: 300000,
    incrementalOnly: true
  },

  output: {
    dbPath: '.similarity/similarity.db',
    reportPath: '.similarity/reports',
    logLevel: 'info'
  }
};
```

## Implementation Plan

### Phase 1: Core Similarity Analysis Engine (4-5 hours)

1. **AST Analysis Implementation**
   - TypeScript/JavaScript AST parsing using `@babel/parser`
   - Structural similarity comparison algorithms
   - Token-based similarity using normalized sequences

2. **Similarity Scoring System**
   - Weighted combination of structural, textual, and semantic scores
   - Confidence assessment based on code unit characteristics
   - Threshold calibration using known duplicate examples

3. **Code Unit Extraction**
   - Function, class, and module boundary detection
   - Metadata extraction (parameters, return types, complexity)
   - Content normalization for comparison

### Phase 2: Database and Storage (2-3 hours)

1. **SQLite Database Setup**
   - Schema implementation with proper indexing
   - Migration system for schema updates
   - Performance optimization for query patterns

2. **Database Operations**
   - CRUD operations for similarity findings
   - Efficient querying by file path and similarity scores
   - Cleanup of stale findings when code changes

### Phase 3: ESLint Integration (2-3 hours)

1. **Custom ESLint Rule**
   - Rule implementation with configurable thresholds
   - Database querying within ESLint execution
   - Appropriate error/warning formatting

2. **ESLint Plugin Package**
   - Plugin structure and metadata
   - Configuration schema validation
   - Integration testing with various ESLint configurations

### Phase 4: Background Process Implementation (2-3 hours)

1. **File System Watcher**
   - Incremental analysis on file changes
   - Debouncing and batching for performance
   - Error handling and recovery

2. **CLI Commands**
   - Full codebase analysis command
   - Incremental analysis command
   - Report generation and export

## Acceptance Criteria

### Functional Requirements

- [ ] **Similarity Detection**: Accurately identifies code units with >70% similarity
- [ ] **Real-time Feedback**: ESLint warnings appear immediately during development
- [ ] **Performance**: Full codebase analysis completes in <2 minutes for typical project size
- [ ] **Incremental Updates**: Changed files trigger targeted re-analysis within 5 seconds
- [ ] **Configuration**: All thresholds and behaviors configurable via config file

### Integration Requirements

- [ ] **ESLint Integration**: Works with existing ESLint configurations
- [ ] **IDE Support**: Warnings visible in VS Code, Cursor, and other editors
- [ ] **CI/CD Integration**: Can run in continuous integration pipelines
- [ ] **Git Integration**: Optional git hook integration for commit-time analysis

### Quality Requirements

- [ ] **Accuracy**: <5% false positive rate for similarity detection
- [ ] **Performance**: <100ms overhead per ESLint run
- [ ] **Reliability**: Handles large codebases (>10k files) without memory issues
- [ ] **Maintainability**: Clear separation between analysis engine and integrations

## Testing Strategy

### Unit Tests

- Similarity algorithm accuracy with known duplicate code pairs
- Database operations and schema migrations
- ESLint rule behavior with various code patterns
- Configuration parsing and validation

### Integration Tests

- End-to-end workflow: code change → analysis → ESLint warning
- Performance testing with large codebases
- Multiple file format support (TS, JS, TSX, JSX)
- Background process reliability and error recovery

### Manual Testing

- Real-world duplicate detection in existing codebase
- Developer workflow integration and usability
- ESLint rule configuration and customization
- Performance impact on development experience

## Risk Assessment

### High Risk

- **False Positives**: Overly aggressive similarity detection annoying developers
- **Performance Impact**: Background analysis slowing down development
- **ESLint Compatibility**: Issues with different ESLint versions/configurations

### Medium Risk

- **Database Corruption**: SQLite database issues affecting analysis history
- **Memory Usage**: Large codebase analysis consuming excessive memory
- **Configuration Complexity**: Too many options confusing users

### Mitigation Strategies

- Extensive calibration using real codebase examples
- Performance benchmarking and optimization
- Graceful degradation when database unavailable
- Sensible defaults with minimal required configuration

## Success Metrics

### Functional Metrics

- Detect 90%+ of manually identified duplicate code patterns
- <2 minute full analysis time for codebases up to 50k LOC
- <5% false positive rate in similarity detection

### Developer Experience Metrics

- Warnings appear within 5 seconds of code changes
- <1% impact on ESLint execution time
- Positive developer feedback on warning usefulness

### Technical Metrics

- 95%+ test coverage for core similarity algorithms
- Support for TypeScript, JavaScript, React components
- Handles codebases up to 100k lines without performance degradation

## Documentation Requirements

### Developer Documentation

- Similarity detection algorithm explanation
- Database schema and querying patterns
- ESLint rule configuration reference
- Performance tuning guide

### User Documentation

- Setup and configuration guide
- Integration with existing development workflows
- Similarity threshold tuning recommendations
- Troubleshooting common issues

## Dependencies

### Prerequisites

- ESLint infrastructure already in place
- TypeScript/JavaScript parsing capabilities
- SQLite for local database storage

### External Dependencies

- `@babel/parser` for AST generation
- `chokidar` for file system watching
- `sqlite3` for database operations
- ESLint plugin development dependencies

## Future Enhancements

### Advanced Features

- Machine learning-based semantic similarity
- Cross-language similarity detection
- Integration with code review tools
- Automated refactoring suggestions

### Integrations

- GitHub/GitLab PR integration
- IDE plugin development
- Continuous integration reporting
- Code quality dashboard integration

## Implementation Notes

### Algorithm Considerations

The similarity detection should balance accuracy with performance:

1. **Structural Similarity**: AST-based comparison catches renamed variables/functions
2. **Textual Similarity**: Token-based comparison catches copy-paste scenarios
3. **Semantic Similarity**: Pattern matching for similar algorithmic approaches
4. **Confidence Scoring**: Higher confidence for longer, more complex code units

### Performance Optimization

- Incremental analysis only processes changed files and their dependencies
- Database indexing optimized for common query patterns
- AST caching for frequently analyzed code units
- Parallel processing for full codebase analysis

### User Experience Design

- Warnings should be actionable with clear next steps
- Similarity scores presented in understandable terms
- Integration should feel natural within existing development workflow
- Configuration should have sensible defaults requiring minimal setup
