# Task: Implement Session Data Validation and Repair

## Overview

Build a comprehensive session data validation and repair system that proactively detects and fixes session data inconsistencies, orphaned references, and workspace path issues to prevent the type of data loss scenario experienced with the 365-session database corruption.

## Context

The session database corruption incident revealed several gaps in session data integrity:

- Orphaned sessions with invalid workspace paths
- Session references to non-existent repositories
- Inconsistent task ID mappings
- Stale session data accumulation

We need proactive validation and automatic repair capabilities to maintain session data health.

## Integration with Chain-of-Execution Monitoring

### Monitoring Data Integrity for Task Graph Execution

**Session Data as Execution State:**
- Session records contain critical execution state for task graph workflows
- Data corruption can interrupt or misdirect automated task execution
- Validation ensures Chain-of-Execution monitoring has reliable data foundation

**Proactive Monitoring Integration:**
- **Execution Health Monitoring**: Validate session data health during task graph execution
- **Real-time Integrity Checks**: Monitor for data corruption during active workflow orchestration
- **Intervention Triggers**: Alert when data issues could impact ongoing task execution
- **Recovery Mechanisms**: Automatic repair of issues that would block workflow progress

**Validation as Execution Quality Assurance:**
- Ensure session-task associations remain intact during parallel execution
- Validate workspace paths for automated session creation during task graph execution
- Monitor repository state consistency across multiple concurrent sessions
- Verify task status propagation data integrity in hierarchical workflows

### Enhanced Validation for Workflow Orchestration

**Workflow-Aware Validation Rules:**
```typescript
interface WorkflowAwareValidator extends SessionDataValidator {
  validateWorkflowExecutionState(sessionId: string): Promise<ExecutionValidationResult>;
  validateTaskGraphConsistency(rootTaskId: string): Promise<GraphValidationResult>;
  validateParallelExecutionSafety(sessionIds: string[]): Promise<ConcurrencyValidationResult>;
}
```

**Integration Points:**
- Validate session data before automated task execution begins
- Monitor data consistency during Chain-of-Execution workflows
- Repair data issues that could impact workflow automation
- Ensure task graph execution has reliable session data foundation

## Requirements

### Core Validation Framework

1. **Session Reference Validation**

   - Verify session workspace paths exist and are accessible
   - Validate repository URLs and local git repository status
   - Check task ID references against task backend data
   - Verify branch references are valid and trackable

2. **Data Consistency Checks**

   - Detect duplicate session names or IDs
   - Identify sessions with conflicting repository paths
   - Find sessions referencing moved/renamed repositories
   - Validate session metadata completeness

3. **Workspace Health Assessment**
   - Check git repository status and health
   - Verify repository remote connectivity
   - Validate branch tracking and sync status
   - Detect uncommitted changes or conflicts

### Automatic Repair Capabilities

4. **Safe Auto-Repairs**

   - Update workspace paths for moved repositories
   - Fix repository URL changes (HTTP ↔ SSH)
   - Repair broken branch tracking references
   - Clean up temporary files and caches

5. **Supervised Repairs**

   - Merge duplicate sessions with user confirmation
   - Resolve conflicting repository paths
   - Handle sessions for deleted repositories
   - Update task ID references after task renumbering

6. **Data Cleanup Operations**
   - Remove sessions older than configurable threshold
   - Archive completed sessions with merged tasks
   - Clean up orphaned session directories
   - Compress session history and logs

### Monitoring and Reporting

7. **Health Monitoring**

   - Regular session health checks
   - Repository accessibility monitoring
   - Git repository status tracking
   - Performance metrics collection

8. **Comprehensive Reporting**
   - Session health dashboard
   - Validation failure summaries
   - Repair operation logs
   - Trend analysis and alerts

## Implementation Plan

### Phase 1: Core Validation Engine

```typescript
interface SessionDataValidator {
  validateSession(session: SessionData): Promise<ValidationResult>;
  validateAllSessions(): Promise<ValidationReport>;
  checkSessionReferences(session: SessionData): Promise<ReferenceReport>;
  assessWorkspaceHealth(session: SessionData): Promise<WorkspaceHealth>;
}

interface ValidationResult {
  isValid: boolean;
  issues: ValidationIssue[];
  repairOptions: RepairOption[];
  severity: "info" | "warning" | "error" | "critical";
}

interface ValidationIssue {
  type: IssueType;
  description: string;
  affectedData: any;
  autoRepairable: boolean;
  repairRisk: "safe" | "moderate" | "dangerous";
}
```

### Phase 2: Repair Engine

```typescript
interface SessionDataRepairer {
  repairSession(session: SessionData, issues: ValidationIssue[]): Promise<RepairResult>;
  repairWorkspacePath(session: SessionData): Promise<PathRepairResult>;
  repairRepositoryReferences(session: SessionData): Promise<RepoRepairResult>;
  cleanupOrphanedData(session: SessionData): Promise<CleanupResult>;
}

interface RepairOption {
  id: string;
  description: string;
  riskLevel: "safe" | "moderate" | "dangerous";
  requiresConfirmation: boolean;
  estimatedDuration: Duration;
  rollbackSupported: boolean;
}
```

### Phase 3: CLI Integration

```typescript
// New sessiondb subcommands
minsky sessiondb validate                          // Validate all sessions
minsky sessiondb validate --session <name>        // Validate specific session
minsky sessiondb repair --auto                    // Auto-repair safe issues
minsky sessiondb repair --interactive             // Interactive repair wizard
minsky sessiondb cleanup --older-than 90d         // Cleanup old sessions
minsky sessiondb health --report                  // Generate health report
minsky sessiondb monitor --schedule daily         // Schedule health checks
```

## Validation Categories

### Repository and Workspace Validation

- **Path Accessibility**: Verify workspace paths exist and are readable
- **Git Repository Health**: Check `.git` directory integrity, remote connectivity
- **Branch Consistency**: Validate branch exists, is tracked, sync status
- **Working Directory State**: Detect uncommitted changes, conflicts, stash status

### Session Data Integrity

- **Metadata Completeness**: Required fields present and valid
- **Task Reference Validity**: Task IDs exist in configured task backend
- **Timestamp Consistency**: Created/updated times are logical
- **Unique Constraints**: No duplicate session names or conflicting data

### Cross-Session Consistency

- **Repository Conflicts**: Multiple sessions claiming same repository path
- **Task Assignment**: No task assigned to multiple active sessions
- **Resource Conflicts**: Port usage, file locks, concurrent access issues

## Repair Strategies

### Safe Automatic Repairs

```typescript
class SafeRepairs {
  // Update paths when repositories are moved
  async updateWorkspacePath(session: SessionData, newPath: string): Promise<void>;

  // Fix repository URL format changes
  async normalizeRepositoryUrl(session: SessionData): Promise<void>;

  // Repair broken git remote tracking
  async fixBranchTracking(session: SessionData): Promise<void>;

  // Clean up temporary files
  async cleanupTemporaryFiles(session: SessionData): Promise<void>;
}
```

### Supervised Repairs

```typescript
class SupervisedRepairs {
  // Merge duplicate sessions
  async mergeDuplicateSessions(sessions: SessionData[]): Promise<MergeResult>;

  // Resolve repository path conflicts
  async resolveRepositoryConflicts(conflicts: RepositoryConflict[]): Promise<void>;

  // Handle deleted repository sessions
  async handleOrphanedSessions(sessions: SessionData[]): Promise<void>;

  // Update task references after renumbering
  async updateTaskReferences(session: SessionData, taskMapping: TaskMapping): Promise<void>;
}
```

### Data Cleanup Operations

```typescript
class DataCleanup {
  // Archive old completed sessions
  async archiveCompletedSessions(olderThan: Duration): Promise<ArchiveResult>;

  // Remove orphaned session directories
  async removeOrphanedDirectories(): Promise<CleanupResult>;

  // Compress session logs and history
  async compressSessionData(sessions: SessionData[]): Promise<CompressionResult>;

  // Clean up broken symbolic links
  async cleanupBrokenSymlinks(): Promise<void>;
}
```

## Error Handling and Safety

### Validation Failure Handling

- **Graceful Degradation**: Continue validation even if individual sessions fail
- **Error Categorization**: Classify errors by severity and impact
- **Recovery Strategies**: Provide multiple repair options for each issue
- **User Communication**: Clear, actionable error messages

### Repair Safety Mechanisms

- **Backup Before Repair**: Create session backup before destructive operations
- **Rollback Capability**: Undo repairs if they cause issues
- **Confirmation Requirements**: User approval for dangerous operations
- **Progress Reporting**: Real-time feedback during repair operations

### Risk Assessment

- **Impact Analysis**: Assess potential consequences of repairs
- **Dependency Checking**: Ensure repairs don't break related functionality
- **Validation Testing**: Verify repairs actually fix the issues
- **Monitoring Integration**: Track repair success/failure rates

## Testing Requirements

### Unit Tests

- Individual validation rule testing
- Repair operation correctness
- Error handling and edge cases
- Performance optimization validation

### Integration Tests

- Full session validation workflows
- Cross-session consistency checking
- Repair operation integration
- Database backend compatibility

### End-to-End Tests

- CLI command functionality
- Real session data scenarios
- Large dataset validation performance
- User workflow validation

## Success Criteria

1. **Prevention**: Detect session data issues before they cause problems
2. **Recovery**: Automatically repair common session data problems
3. **Safety**: No data loss during validation or repair operations
4. **Performance**: Handle large numbers of sessions efficiently
5. **Usability**: Clear reporting and intuitive repair workflows
6. **Reliability**: Consistent validation results across different environments

## Dependencies

- Database integrity checker (from current work)
- Enhanced storage backend factory (from current work)
- Git repository utilities
- Task backend integration
- Session workspace management

## Acceptance Criteria

- [ ] Validate all session data integrity issues identified in database corruption
- [ ] Automatically repair safe issues without user intervention
- [ ] Provide interactive repair wizard for complex issues
- [ ] Generate comprehensive session health reports
- [ ] Handle large session datasets (365+ sessions) efficiently
- [ ] Include rollback capability for repair operations
- [ ] Pass all validation tests on real session data
- [ ] Documentation for validation rules and repair procedures
