# Task 358: PR Approval and Merge Decoupling - Implementation Plan

## Analysis Summary

### Current Coupling Discovery

**Critical Coupling Point Identified:**
- **Location**: `src/domain/session/session-approve-operations.ts:324`
- **Code**: `await repositoryBackend.mergePullRequest(prIdentifier, sessionNameToUse)`
- **Issue**: Approval and merge happen atomically in one operation
- **Impact**: No intermediate state between review approval and merge completion

**Current Workflow:**
```
session approve → repositoryBackend.mergePullRequest() → Task Status: DONE
```

**Repository Backend Interface (Current):**
```typescript
// Line 236-243: src/domain/repository/index.ts
mergePullRequest(prIdentifier: string | number, session?: string): Promise<MergeInfo>;
```

### Task 359 Integration Point

Task 359 establishes the pattern: `session pr create|list|get`

**Alignment Strategy for Task 358:**
- **Option A**: `session review approve|merge` (new command group)
- **Option B**: `session pr approve|merge` (extend task 359's PR subcommands)  
- **Option C**: `session approve` (approve-only) + `session merge` (separate commands)

## Revised Implementation Plan - Session-Centric Approval Model

### Core Insight: Sessions, Not Tasks, Have PRs and Approvals

**Key Realization**: 
- 1 Task can have multiple Sessions
- Each Session creates its own PR  
- Approval/merge operations target the Session's PR
- Task status becomes an aggregate of Session statuses

### Phase 1: Simple Session PR Tracking

#### 1.1 Extended Session Record

**Current**: Sessions have no PR tracking
**New**: Simple fields to track PR branch and approval state

```typescript
interface SessionRecord {
  // ... existing fields ...
  
  // NEW: Simple PR tracking
  prBranch?: string;        // PR branch if one exists ("pr/session-name")
  prApproved?: boolean;     // Whether this session's PR is approved
}
```

That's it. No complex status enums, no extensive metadata. Just what we need.

### Phase 2: Repository Backend Interface Extension

#### 2.1 Session-Centric Interface Methods

**File**: `/Users/edobry/.local/state/minsky/sessions/task358/src/domain/repository/index.ts`

```typescript
export interface RepositoryBackend {
  // ... existing methods ...

  /**
   * NEW: Approve THIS SESSION'S pull request
   * @param prIdentifier - PR number/ID for this session's PR
   * @param reviewComment - Optional review comment
   * @returns Promise<ApprovalInfo> - Information about the approval
   */
  approvePullRequest(
    prIdentifier: string | number, 
    reviewComment?: string
  ): Promise<ApprovalInfo>;

  /**
   * NEW: Check approval status of THIS SESSION'S pull request
   * @param prIdentifier - PR number/ID for this session's PR
   * @returns Promise<ApprovalStatus> - Current approval state
   */
  getPullRequestApprovalStatus(
    prIdentifier: string | number
  ): Promise<ApprovalStatus>;

  // Existing method - now clearly session-scoped
  mergePullRequest(prIdentifier: string | number, session?: string): Promise<MergeInfo>;
}
```

#### 1.2 New Interface Types

```typescript
export interface ApprovalInfo {
  reviewId: string | number;
  approvedBy: string;
  approvedAt: string;
  comment?: string;
  prNumber: string | number;
  metadata?: any;
}

export interface ApprovalStatus {
  isApproved: boolean;
  approvals: ApprovalInfo[];
  requiredApprovals: number;
  canMerge: boolean;
  prState: "open" | "closed" | "merged" | "draft";
  metadata?: any;
}
```

#### 1.3 Backend-Specific Implementation

**GitHub Backend** (`src/domain/repository/github.ts`):
```typescript
async approvePullRequest(prIdentifier: string | number, reviewComment?: string): Promise<ApprovalInfo> {
  // Use GitHub API to submit PR review with "APPROVE" state
  // POST /repos/{owner}/{repo}/pulls/{pr_number}/reviews
}

async getPullRequestApprovalStatus(prIdentifier: string | number): Promise<ApprovalStatus> {
  // GET /repos/{owner}/{repo}/pulls/{pr_number}/reviews
  // Check review states, required approvals, branch protection rules
}
```

**Local/Remote Backend** (`src/domain/repository/local.ts`, `remote.ts`):
```typescript
async approvePullRequest(prIdentifier: string | number, reviewComment?: string): Promise<ApprovalInfo> {
  // Store approval in task metadata or local state
  // No git operation needed - just metadata tracking
}

async getPullRequestApprovalStatus(prIdentifier: string | number): Promise<ApprovalStatus> {
  // Check local metadata for approval state
  // Return simplified approval status
}
```

### Phase 3: Task Status Aggregation (New Model)

#### 3.1 Task Status as Session Aggregate

**Key Change**: Task status is computed from session PR fields

```typescript
// Simple task status calculation
function computeTaskStatus(sessions: SessionRecord[]): TaskStatus {
  if (sessions.length === 0) return "PENDING";
  
  const anyActiveDev = sessions.some(s => !s.prBranch); // no PR yet
  if (anyActiveDev) return "IN_PROGRESS";
  
  const anyPendingApproval = sessions.some(s => s.prBranch && !s.prApproved);
  if (anyPendingApproval) return "IN_REVIEW";
  
  // All sessions have PRs and are approved
  return "DONE";
}
```

Simple logic based on the two fields we're tracking.

### Phase 4: Session-Centric Command Structure

#### 4.1 Session Commands (Session-Focused)

**New Command Behavior:**
```bash
# NEW: Approve THIS SESSION'S PR
minsky session approve [session-name]
# → Sets session status to APPROVED  
# → Calls repositoryBackend.approvePullRequest() for session's PR
# → Updates session approval metadata
# → Task status updated as aggregate

# NEW: Merge THIS SESSION'S approved PR
minsky session merge [session-name]  
# → Requires session status APPROVED
# → Calls repositoryBackend.mergePullRequest() for session's PR
# → Sets session status to MERGED
# → Task status updated as aggregate

# BACKWARD COMPATIBILITY: Legacy combined operation
minsky session approve --merge [session-name]
# → Session: ACTIVE → APPROVED → MERGED (atomic)
# → Shows deprecation warning
```

#### 4.2 Multi-Session Task Example

```bash
# Task #123 with multiple sessions
minsky session start --task 123 --name "backend-api"
# ... work on backend ...
minsky session pr                    # Create PR #456
minsky session approve               # Session: APPROVED

minsky session start --task 123 --name "frontend-ui"  
# ... work on frontend ...
minsky session pr                    # Create PR #457
minsky session approve               # Session: APPROVED

# At this point: Task #123 status = "IN_REVIEW" (2 approved sessions)

minsky session merge --name "backend-api"    # PR #456 merged
minsky session merge --name "frontend-ui"    # PR #457 merged

# Now: Task #123 status = "DONE" (all sessions merged)
```

#### 3.2 Command Implementation Structure

**Files to Create/Modify:**

1. **`src/domain/session/commands/subcommands/approve-subcommand.ts`** (MODIFY)
   - Change to approve-only by default
   - Add `--merge` flag for backward compatibility
   - Add deprecation warning for `--merge` usage

2. **`src/domain/session/commands/subcommands/merge-subcommand.ts`** (NEW)
   - New merge-only subcommand
   - Validates APPROVED status before merging
   - Calls repositoryBackend.mergePullRequest()

3. **`src/domain/session/session-approve-operations.ts`** (MODIFY)
   - Split `approveSessionImpl` into `approveSession` and `mergeSession`
   - Create `approveSessionWithMerge` for backward compatibility

#### 3.3 Enhanced Operation Interfaces

```typescript
// NEW: Approve-only result  
export interface ApprovalResult {
  session: string;
  taskId?: string;
  approvalInfo: ApprovalInfo;
  previousStatus: string;
  newStatus: "APPROVED";
}

// NEW: Merge-only result
export interface MergeResult {
  session: string;
  taskId?: string;
  mergeInfo: MergeInfo;
  previousStatus: "APPROVED";
  newStatus: "DONE";
}

// MODIFIED: Combined result for backward compatibility
export interface ApprovalWithMergeResult {
  session: string;
  taskId?: string;
  approvalInfo: ApprovalInfo;
  mergeInfo: MergeInfo;
  previousStatus: string;
  newStatus: "DONE";
  isLegacyMode: true;
}
```

### Phase 4: Implementation Strategy

#### 4.1 Development Sequence

1. **Repository Backend Interface** (Low Risk)
   - Add new methods to interface
   - Implement GitHub backend methods
   - Implement Local/Remote backend stubs
   - Unit tests for new methods

2. **Task Status Enhancement** (Medium Risk) 
   - Add APPROVED status to constants
   - Update task status validation
   - Add metadata schema support
   - Update status transition logic

3. **Session Operations Refactor** (High Risk)
   - Extract approve-only logic from current implementation
   - Create merge-only operation
   - Add backward compatibility layer
   - Comprehensive integration tests

4. **Command Layer Updates** (Medium Risk)
   - Modify approve subcommand
   - Create merge subcommand  
   - Update CLI registration
   - Update help documentation

#### 4.2 Backward Compatibility Strategy

**Phase 1: Maintain Current Behavior**
```typescript
// Current: session approve → approve + merge
export async function approveSessionImpl(params) {
  if (params.merge !== false) {
    // Default behavior: approve + merge (maintain compatibility)
    return await approveSessionWithMerge(params);
  } else {
    // New behavior: approve only  
    return await approveSessionOnly(params);
  }
}
```

**Phase 2: Gradual Migration**
```typescript
// Add deprecation warning
if (params.merge !== false) {
  log.warn("⚠️  Combined approve+merge is deprecated. Use 'session merge' after approval.");
}
```

**Phase 3: Default Change** (Future)
```typescript
// Eventually: session approve → approve only (breaking change)
// Require explicit --merge flag for combined operation
```

### Phase 5: Error Handling Strategy

#### 5.1 Approval Error Scenarios

```typescript
// Approval-specific errors
export class ApprovalError extends MinskyError {
  constructor(message: string, public prIdentifier: string | number) {
    super(message);
  }
}

export class InsufficientPermissionsError extends ApprovalError {}
export class AlreadyApprovedError extends ApprovalError {}
export class PullRequestNotFoundError extends ApprovalError {}
```

#### 5.2 Merge Error Scenarios

```typescript
// Merge-specific errors  
export class MergeError extends MinskyError {
  constructor(message: string, public prIdentifier: string | number) {
    super(message);
  }
}

export class NotApprovedError extends MergeError {}
export class MergeConflictError extends MergeError {}
export class BranchProtectionError extends MergeError {}
```

#### 5.3 State Validation

```typescript
// Pre-merge validation
async function validateMergeEligibility(taskId: string, prIdentifier: string | number) {
  // 1. Check task status is APPROVED
  const status = await taskService.getTaskStatus(taskId);
  if (status !== TASK_STATUS.APPROVED) {
    throw new NotApprovedError(`Task ${taskId} must be approved before merging (current: ${status})`);
  }

  // 2. Check PR approval status
  const approvalStatus = await repositoryBackend.getPullRequestApprovalStatus(prIdentifier);
  if (!approvalStatus.canMerge) {
    throw new BranchProtectionError("PR does not meet merge requirements");
  }
}
```

### Phase 6: Testing Strategy

#### 6.1 Unit Tests

**Repository Backend Interface:**
- Test approval operations for each backend type
- Test approval status queries
- Test error scenarios (permissions, not found, etc.)

**Session Operations:**
- Test approve-only workflow
- Test merge-only workflow  
- Test backward compatibility mode
- Test status transitions

#### 6.2 Integration Tests

**End-to-End Workflows:**
```typescript
describe("Decoupled Approval/Merge Workflow", () => {
  test("should approve then merge successfully", async () => {
    // 1. Create session and PR
    // 2. session approve → status APPROVED
    // 3. session merge → status DONE
  });

  test("should maintain backward compatibility", async () => {
    // session approve --merge → status DONE (legacy mode)
  });

  test("should prevent merge without approval", async () => {
    // session merge → should fail if not APPROVED
  });
});
```

#### 6.3 Manual Testing

**GitHub Integration:**
- Real GitHub repository testing
- PR approval/merge workflow validation
- Branch protection rule compliance
- Multiple reviewer scenarios

## Benefits of Session-Centric Approval Model

### 1. Conceptual Clarity ✅
- **1 Session = 1 PR = 1 Approval**: Clean, understandable model
- Sessions have approval lifecycle, tasks aggregate session states
- No confusion between task-level and PR-level approvals
- Natural alignment with how Minsky actually works

### 2. Multi-Session Task Support ✅
- Tasks can have multiple sessions with independent PR workflows
- Each session's PR approved and merged independently  
- Task completion when all sessions complete
- Supports complex task decomposition strategies

### 3. Platform Integration ✅
- **GitHub**: Leverages real PR reviews, branch protection, CODEOWNERS
- **Local**: Workflow checkpoints with metadata tracking
- Repository backend focuses on session's specific PR
- Platform complexity handled appropriately

### 4. Enhanced Collaboration ✅  
- Code review without merge pressure per session
- Multi-reviewer workflows naturally supported by platforms
- Role separation (reviewers vs. release managers)
- Timing flexibility (approve now, merge during deployment windows)

### 5. Workflow Flexibility ✅
- Stacked PRs: Multiple sessions for one task, merged sequentially
- Parallel PRs: Multiple sessions, different approaches, best one wins
- Incremental delivery: Merge sessions as they're ready
- Rollback capability: Approved but unmerged sessions can be abandoned

## Implementation Timeline

**Week 1-2**: Repository Backend Interface Extension
**Week 3**: Task Status and Metadata Enhancement  
**Week 4-5**: Session Operations Refactor
**Week 6**: Command Layer Updates and Integration
**Week 7**: Testing and Documentation
**Week 8**: Integration Testing and Refinement

## Risk Mitigation

**High Risk**: Session operations refactor
- **Mitigation**: Comprehensive test coverage, gradual rollout, feature flags

**Medium Risk**: Backward compatibility
- **Mitigation**: Explicit compatibility layer, deprecation warnings, migration guide

**Low Risk**: Repository backend interface  
- **Mitigation**: Interface-first development, mock implementations for testing

## Success Criteria - Session-Centric Model

### Core Session Approval Workflow
- [ ] `session approve` approves the session's specific PR (not task-wide)
- [ ] `session merge` merges the session's approved PR with validation
- [ ] `session approve --merge` maintains backward compatibility with deprecation warnings
- [ ] Session status properly transitions: ACTIVE → PR_CREATED → APPROVED → MERGED

### Multi-Session Task Support  
- [ ] Multiple sessions per task work independently
- [ ] Task status aggregates correctly from session statuses
- [ ] Each session has its own PR approval/merge lifecycle
- [ ] Task completion when all associated sessions are merged

### Platform Integration
- [ ] GitHub backend leverages native GitHub PR approval features per session
- [ ] Local backend tracks approval metadata per session
- [ ] Repository backend operations target session's specific PR, not task concepts
- [ ] Platform complexity (multiple reviewers, branch protection) handled by platform

### Backward Compatibility
- [ ] All existing session approve tests pass with compatibility mode
- [ ] Current workflows continue to work during transition
- [ ] Clear migration documentation provided with session-centric examples

### Testing and Validation
- [ ] New session approval/merge workflow tests pass
- [ ] Multi-session task workflows tested end-to-end  
- [ ] Session status aggregation logic tested thoroughly

## Alignment with Task 359

This implementation aligns with Task 359's command structure by:

1. **Following Subcommand Pattern**: Similar to `session pr create|list|get`
2. **Maintaining Consistency**: Same parameter resolution patterns
3. **Future Extensibility**: Ready for `session pr approve|merge` integration if desired
4. **Clean Architecture**: Separate concerns like Task 359 separates PR operations

The approval/merge decoupling provides the foundation for Task 359's potential future enhancement: `session pr merge` as mentioned in their future enhancements section.
