# Explore PR Approval and Merge Decoupling

**Status:** NEW  
**Priority:** HIGH  
**Dependencies:** 
- Task #161 (Add GitHub PR Workflow) - FOUNDATIONAL DEPENDENCY
- Task #174 (Review Session PR Workflow Architecture) - COMPLETED
- Task #359 (Restructure Session PR Command with Explicit Subcommands) - COMMAND STRUCTURE DEPENDENCY

## Context

The current Minsky session workflow couples PR approval and merging in a single `session approve` command. While this works for the prepared merge commit workflow (local/remote repositories), it doesn't align with standard PR workflows used by GitHub, GitLab, and other platforms where **approval** and **merging** are distinct operations.

This architectural limitation becomes critical when implementing Task #161 (GitHub PR workflow), as GitHub's native workflow supports:

1. **PR Approval**: Code review approval without merging
2. **PR Merging**: Separate merge operation (potentially by different person)
3. **Multi-Reviewer Workflows**: Multiple approvals before merge
4. **Branch Protection**: Merge restrictions based on approval state

**Key Insight**: The current coupling forces Minsky to either:
- Use GitHub's native approval system but bypass it with immediate merging
- Implement a non-standard workflow that doesn't leverage GitHub's collaboration features

## Problem Analysis

### Current Coupling in Repository Backends

**Local/Remote Git Backend** (`session approve`):
```typescript
// Current: Approval and merge happen atomically
await repositoryBackend.fastForwardMerge(preparedCommit);
await taskService.updateStatus(taskId, 'DONE');
```

**GitHub Backend** (proposed in Task #161):
```typescript
// Problematic: Forces immediate merge after approval
await githubApi.mergePullRequest(prNumber);
await taskService.updateStatus(taskId, 'DONE');
```

### Architectural Issues

1. **No Intermediate State**: Tasks jump from IN-REVIEW directly to DONE
2. **Single Actor Assumption**: Same person who creates PR must merge it
3. **Limited Collaboration**: Cannot leverage multi-reviewer workflows
4. **Non-Standard Patterns**: Doesn't match industry-standard PR workflows
5. **Inflexible Timing**: Approval and merge must happen simultaneously

## Requirements

### 1. Separate PR Approval and Merge Operations

**New Task Status Flow**:
```
ASSIGNED → IN-PROGRESS → IN-REVIEW → APPROVED → DONE
                                  ↗        ↘
                             (approval)  (merge)
```

**Decoupled Commands**:
```bash
# Create PR (existing)
minsky session pr

# Approve PR (new - separate from merge)
minsky session approve

# Merge approved PR (new - separate command)
minsky session merge
```

### 2. Repository Backend Interface Extension

**Enhanced RepositoryBackend Interface**:
```typescript
interface RepositoryBackend {
  // Existing PR creation
  createPullRequest(title: string, body: string, sourceBranch: string, baseBranch: string): Promise<PRInfo>;
  
  // NEW: Separate approval operation
  approvePullRequest(prNumber: number, reviewComment?: string): Promise<ApprovalInfo>;
  
  // NEW: Separate merge operation  
  mergePullRequest(prNumber: number, mergeStrategy?: MergeStrategy): Promise<MergeInfo>;
  
  // NEW: Check approval status
  getPullRequestApprovalStatus(prNumber: number): Promise<ApprovalStatus>;
}

interface ApprovalInfo {
  reviewId: number;
  approvedBy: string;
  approvedAt: string;
  comment?: string;
}

interface ApprovalStatus {
  isApproved: boolean;
  approvals: ApprovalInfo[];
  requiredApprovals: number;
  canMerge: boolean;
}
```

### 3. Task Status Enhancement

**New Task Status**: `APPROVED`
- Indicates PR has been approved but not yet merged
- Allows time gap between approval and merge
- Supports multi-step review processes

**Enhanced Task Metadata**:
```yaml
---
# Existing fields...

# New approval tracking
approval_info:
  approved_by: username
  approved_at: 2023-06-15T14:32:00Z
  review_comment: "LGTM - great implementation"
  
github_pr:
  pr_number: 123
  status: "approved"  # open, approved, merged
  approval_count: 2
  required_approvals: 1
  can_merge: true
---
```

### 4. Backward Compatibility Strategy

**Option A: Unified Command with Flags**
```bash
# Current behavior (approve + merge)
minsky session approve

# New separate operations
minsky session approve --approve-only
minsky session merge
```

**Option B: Separate Commands with Legacy Support**
```bash
# New preferred workflow
minsky session approve  # approve only
minsky session merge    # merge only

# Legacy compatibility
minsky session approve --merge  # old behavior
```

**Option C: Progressive Migration**
```bash
# Phase 1: Keep current behavior, add warnings
minsky session approve  # works as before, shows deprecation warning

# Phase 2: Introduce new commands
minsky session review approve
minsky session review merge

# Phase 3: Migrate to new commands
minsky session approve   # approve only
minsky session merge     # merge only
```

### 5. Repository Backend-Specific Behavior

**GitHub Backend**:
- `session approve`: Submit GitHub PR review with "APPROVE" state
- `session merge`: Merge via GitHub API (respects branch protection rules)
- Supports multiple reviewers and approval requirements

**Local/Remote Git Backend**:
- `session approve`: Mark as approved in task metadata (no git operation)
- `session merge`: Execute prepared merge commit (existing behavior)
- Maintains current functionality while enabling decoupled workflow

**Future GitLab/Bitbucket Backends**:
- Each can implement approval/merge according to platform-specific patterns
- Standardized interface enables consistent CLI experience

## Benefits

### 1. Industry Standard Alignment
- Matches GitHub, GitLab, and Bitbucket PR workflows
- Familiar patterns for developers coming from other tools
- Enables integration with platform-native review processes

### 2. Enhanced Collaboration
- **Code Review Workflows**: Approval without immediate merge pressure
- **Multi-Reviewer Support**: Multiple people can approve before merge
- **Timing Flexibility**: Approve during work hours, merge during deployment windows
- **Role Separation**: Reviewers vs. Release Managers can have different responsibilities

### 3. Improved Control
- **Branch Protection Integration**: Respect GitHub's merge restrictions
- **CI/CD Integration**: Merge only after approval + successful builds
- **Release Coordination**: Batch approved PRs for coordinated releases
- **Rollback Capability**: Approved but unmerged PRs can be easily abandoned

### 4. Platform Feature Leverage
- **GitHub**: Required reviewers, CODEOWNERS, status checks
- **GitLab**: Merge requests approvals, approval rules
- **Enterprise Features**: Compliance and audit trails

## Implementation Considerations

### 1. State Management Complexity
- **Current**: Simple ASSIGNED → IN-PROGRESS → IN-REVIEW → DONE
- **New**: Must handle APPROVED state and transitions
- **Edge Cases**: What if approval is removed? Multiple approvals?

### 2. Error Handling
- **Approval Failures**: Insufficient permissions, already approved
- **Merge Failures**: Conflicts, branch protection violations  
- **State Inconsistencies**: PR merged externally, approval revoked

### 3. User Experience
- **Command Discovery**: How do users learn about separate commands?
- **Workflow Guidance**: When to approve vs. merge?
- **Error Recovery**: Clear messages for workflow violations
- **CLI Consistency**: Align approval/merge commands with session PR structure from Task #359

### 4. Migration Strategy
- **Existing Sessions**: How to handle in-flight work?
- **Documentation Updates**: Extensive examples and migration guides
- **Training**: Team adoption of new patterns

## Open Questions

### 1. Default Behavior Decision
**Question**: Should `session approve` default to approve-only or approve+merge?

**Options**:
- **A**: Default to approve-only (forces explicit merge step)
- **B**: Default to approve+merge (maintains current behavior)
- **C**: Prompt user for choice (interactive confirmation)
- **D**: Repository backend determines default (GitHub=approve-only, Local=approve+merge)

### 2. Task Status Granularity
**Question**: How granular should task status tracking be?

**Options**:
- **Minimal**: Keep current statuses, track approval in metadata only
- **Moderate**: Add APPROVED status between IN-REVIEW and DONE
- **Detailed**: Add multiple approval states (NEEDS-REVIEW, APPROVED, MERGE-READY)

### 3. Multi-PR Tasks
**Question**: How should this work for tasks that span multiple PRs?

**Considerations**:
- **Stacked PRs**: Dependencies between multiple PRs
- **Parallel PRs**: Multiple independent changes for one task
- **Partial Approval**: Some PRs approved, others still in review

### 4. Approval Authority
**Question**: Who can approve vs. merge PRs in Minsky?

**Options**:
- **Task Owner Only**: Only task assignee can approve/merge
- **Team Members**: Any team member can approve, subset can merge
- **Platform Rules**: Defer to GitHub/GitLab permission system
- **Configurable**: Allow per-project approval policies

## Investigation Methodology

### Phase 1: Current State Analysis
1. **Map Current Approval/Merge Flow**: Document exact steps in session approve
2. **Repository Backend Review**: Analyze coupling in existing implementations  
3. **Task Status Lifecycle**: Map current status transitions and identify gaps
4. **CLI Command Analysis**: Review session command structure and patterns
5. **Session PR Command Structure**: Align with Task #359 decisions on subcommand patterns

### Phase 2: Platform Research
1. **GitHub PR Workflow Study**: Document GitHub's approval/merge separation
2. **GitLab Comparison**: How does GitLab handle approval vs. merge?
3. **Industry Patterns**: Survey other tools (Azure DevOps, Bitbucket)
4. **Best Practices**: Research team workflows and collaboration patterns

### Phase 3: Design Exploration
1. **Interface Design**: Multiple approaches to separating operations
2. **Backward Compatibility**: Strategies for smooth migration
3. **State Management**: Robust handling of approval/merge states
4. **Error Scenarios**: Comprehensive error case analysis

### Phase 4: User Experience Validation
1. **Developer Workflow Simulation**: Walk through common scenarios
2. **Team Collaboration Scenarios**: Multi-person review workflows
3. **Migration Path Testing**: How existing users adapt to changes
4. **Documentation Requirements**: What guidance do users need?

## Success Criteria

### Technical Success
- [ ] Clean separation of approval and merge operations in repository backends
- [ ] Backward compatibility with existing `session approve` behavior
- [ ] Robust state management for new APPROVED task status
- [ ] Platform-specific implementations leverage native approval features

### User Experience Success  
- [ ] Intuitive command structure that matches industry patterns
- [ ] Clear migration path from current workflow
- [ ] Comprehensive error handling and recovery guidance
- [ ] Documentation and examples for common scenarios

### Architectural Success
- [ ] Repository backend interface properly abstracts platform differences
- [ ] Task status model accurately represents approval/merge lifecycle
- [ ] CLI commands provide appropriate flexibility without complexity
- [ ] Integration points prepared for future platform backends

## Dependencies and Relationships

**Foundational Dependencies**:
- **Task #161**: This exploration directly informs GitHub PR workflow implementation
- **Task #174**: Completed session PR architecture review provides context
- **Task #359**: Command structure decisions impact approval/merge command design

**Related Work**:
- **Repository Backend Interface** (Task #014): May need interface extensions
- **Task Status Model** (ADR 002): APPROVED status addition
- **Multi-Backend Architecture** (Task #356): Cross-platform consistency

**Future Enablement**:
- **GitLab Integration**: Decoupled approval/merge enables GitLab backend
- **Enterprise Features**: Supports compliance and audit requirements
- **Advanced Workflows**: Enables stacked PRs, release trains, etc.

## Solution

This exploration is **foundational** for Task #161 and will significantly impact the session PR workflow architecture going forward.

### Investigation Plan
1. **Conduct Investigation**: Execute the four-phase methodology above
2. **Create Design Proposal**: Specific recommendation for implementation approach
3. **Prototype Core Interface**: Implement repository backend interface changes
4. **Validate User Experience**: Test CLI command design with real workflows
5. **Plan Migration Strategy**: Detailed plan for backward compatibility
6. **Update Task #161**: Incorporate findings into GitHub PR workflow implementation

## Notes

This task represents a critical architectural decision point for Minsky's PR workflow. The outcome will determine whether Minsky can effectively leverage platform-native collaboration features or remains limited to non-standard workflows that bypass industry-standard patterns.

**Dependency on Task #359**: The command structure decisions in Task #359 (restructuring `session pr` with explicit subcommands) will directly influence how approval and merge commands should be designed. If Task #359 establishes patterns like `session pr create`, `session pr list`, `session pr get`, then the approval/merge commands should follow similar patterns (e.g., `session review approve`, `session review merge` or integrated into the `session pr` subcommand structure). This exploration must align with whatever CLI patterns are established in Task #359 to maintain consistency across the session command interface.
