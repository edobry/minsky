# ADR-002: Explicit Task Status with Git-Derived Insights

## Status
Proposed

## Context

Task status tracking has two potential approaches:

1. **Explicit Status**: Store status as data (TODO, IN-PROGRESS, DONE, etc.)
2. **Implicit Status**: Derive from git state (branch exists, PR open, PR merged)

The question is whether task status should be explicitly tracked or implicitly derived from git operations.

### Git-Derived Status Mapping
- Session exists → IN-PROGRESS
- PR open → IN-REVIEW  
- PR merged → DONE
- Branch deleted → CLOSED

### Challenges with Pure Git Derivation
- BLOCKED status has no git equivalent
- TODO status ambiguous (no session vs not started)
- Custom workflows don't map to git operations
- Time lag between git state and logical status
- Cross-repo tasks have multiple git states

## Decision

**Use explicit task status as the primary mechanism, with git-derived insights as supplementary information.**

### Status Model:
```typescript
enum TaskStatus {
  TODO = "TODO",
  IN_PROGRESS = "IN-PROGRESS", 
  IN_REVIEW = "IN-REVIEW",
  DONE = "DONE",
  BLOCKED = "BLOCKED",
  CANCELLED = "CANCELLED"
}

interface TaskGitInsights {
  hasSession: boolean;
  sessionBranch?: string;
  hasPR: boolean;
  prNumber?: number;
  prState?: "open" | "merged" | "closed";
  suggestedStatus?: TaskStatus;
}
```

## Rationale

### 1. Explicit Status Advantages
- **Clear Intent**: Status reflects actual state, not git artifacts
- **Flexibility**: Supports workflows beyond git conventions
- **Speed**: No git operations required to check status
- **Custom States**: BLOCKED, BACKLOG, etc. have no git equivalent

### 2. Git Insights Value
- **Validation**: Detect status/git mismatches
- **Automation**: Auto-update status on PR merge
- **Context**: Show git state alongside status
- **Migration**: Help derive initial status

### 3. Hybrid Benefits
- Users can manually set status
- System can suggest updates based on git
- Dashboards show both explicit and derived state
- Supports non-git workflows

## Consequences

### Positive
- ✅ Supports all workflow types
- ✅ Fast status queries
- ✅ Clear user intent
- ✅ Git automation possible
- ✅ Custom status values

### Negative
- ❌ Status can diverge from git state
- ❌ Requires explicit updates
- ❌ Additional data to maintain

### Mitigation
- Provide git-status sync command
- Show warnings for mismatches
- Automate common transitions

## Implementation

### 1. Database Schema
```sql
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  status VARCHAR(20) NOT NULL DEFAULT 'TODO',
  -- git insights cached separately
);

CREATE TABLE task_git_insights (
  task_id INTEGER PRIMARY KEY,
  has_session BOOLEAN,
  session_branch VARCHAR(255),
  has_pr BOOLEAN,
  pr_number INTEGER,
  pr_state VARCHAR(20),
  updated_at TIMESTAMP
);
```

### 2. CLI Commands
```bash
# Explicit status update
minsky task status set 123 BLOCKED

# Sync with git state
minsky task status sync 123

# Bulk sync all tasks
minsky task status sync --all
```

### 3. Status Rules
- Manual updates always take precedence
- Git sync can be automated via hooks
- Warnings shown for divergence
- Status history tracked for audit

## References

- Task #325: Task Backend Architecture Analysis
- Git workflow conventions
- User feedback on status tracking