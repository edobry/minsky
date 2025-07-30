# Explore Active Sessions Command and Task/Session Equivalence Analysis

## Status

TODO

## Priority

MEDIUM

## Description

Explore the concept of adding a command to list "active sessions" and analyze its relationship to the ongoing Task #229 task/session equivalence exploration to determine if such a command would provide value or become redundant.

## Background

The current Minsky CLI includes `minsky session list` which shows all sessions, but there's no specific command to filter for "active" sessions. With the recent completion of Task #229, mandatory task-session association has been implemented, fundamentally changing the session management landscape and potentially making active sessions redundant with active tasks.

## Current State Analysis (Post-Task #229)

### Existing Session Management

- **`minsky session list`**: Lists all sessions with optional verbose mode
- **Session-task relationship**: **ALL sessions now REQUIRE task association** (mandatory since Task #229)
- **Task status integration**: Sessions with tasks automatically update task status to `IN_PROGRESS`
- **Session lifecycle**: Sessions exist until "approved" (merged via PR)

### Task #229 Implementation Status: ✅ COMPLETED

Task #229 has been **fully implemented** with the following changes:
- **Mandatory task association**: All sessions now require either `--task` or `--description`
- **Auto-task creation**: `minsky session start --description "Fix bug"` automatically creates a task
- **Migration completed**: All 13 existing taskless sessions have been migrated
- **Schema validation enforced**: System blocks sessions without task association
- **Task/session equivalence achieved**: Every session is now associated with exactly one task

## Investigation Objectives

### 1. Define "Active Sessions" in Post-Task #229 Architecture

**Current Reality (Task #229 Complete):**
- [ ] Analyze what constitutes an "active" session when all sessions have task associations
- [ ] Determine if "active" means "sessions with IN_PROGRESS tasks" vs. "sessions not yet approved/merged"
- [ ] Assess whether session lifecycle differs from task lifecycle in meaningful ways

### 2. Evaluate Task/Session Equivalence Impact

**Core Question**: Since every session now has exactly one task association:
- [ ] Is `minsky tasks list --status IN_PROGRESS` functionally equivalent to "active sessions"?
- [ ] Do sessions and tasks have different lifecycles that justify separate "active" commands?
- [ ] Are there session-specific attributes (workspace state, branch info) that tasks don't capture?

### 3. Analyze Current Implementation

- [ ] Review `minsky session list` vs. `minsky tasks list --status IN_PROGRESS` output differences
- [ ] Identify what session-specific information is available vs. task information
- [ ] Assess performance implications of each approach

### 4. Assess Command Value Proposition

**Potential Benefits:**
- [ ] Workspace-specific information (directories, branches) not available in task lists
- [ ] Developer familiarity with session-centric workflow
- [ ] Different filtering options (by repo, by workspace state)

**Potential Redundancy:**
- [ ] ✅ **CONFIRMED**: `minsky tasks list --status IN_PROGRESS` would show all active work
- [ ] Task-based filtering likely more comprehensive than session-based
- [ ] Additional command complexity without clear differentiation

## Implementation Considerations

### Scenario 1: Active Sessions Still Provides Value

If sessions offer unique information not available in tasks:
- [ ] Add `--active` flag to existing `minsky session list` command
- [ ] Define active criteria for sessions with mandatory task association
- [ ] Focus on session-specific attributes (workspace paths, git branches, etc.)

### Scenario 2: Task-Based Filtering is Sufficient ✅ **LIKELY**

Given Task #229's completion and task/session equivalence:
- [ ] Determine if `minsky tasks list --status IN_PROGRESS` meets the use case
- [ ] Consider enhancing task list output with session information
- [ ] Document this as the recommended approach for finding active work

### Scenario 3: Enhanced Task Listing

If task listing needs session information:
- [ ] Add session workspace details to task list output
- [ ] Implement `--include-session-info` flag for task commands
- [ ] Provide unified view of tasks with associated session details

## Deliverables

1. **Analysis Report**: Detailed findings on active sessions definition and current state
2. **Redundancy Assessment**: Clear evaluation of overlap with Task #229 work
3. **Recommendation**: Whether to proceed, wait, or pursue alternative approaches
4. **Implementation Plan**: If proceeding, detailed technical specification

## Success Criteria

- [ ] Clear definition of what constitutes an "active session"
- [ ] Thorough analysis of relationship to Task #229's task/session equivalence work
- [ ] Data-driven recommendation on command necessity and value
- [ ] If implementing, clear specification that aligns with overall Minsky architecture

## Dependencies

- **Task #229**: ✅ **COMPLETED** - Mandatory task-session association implemented
- **Current session management**: Understanding of existing `minsky session list` functionality
- **Task status system**: Understanding of task lifecycle and status management
- **Post-#229 architecture**: Analysis of session behavior with mandatory task associations

## Updated Notes

With Task #229 **completed**, this exploration now focuses on determining whether "active sessions" provides any unique value beyond `minsky tasks list --status IN_PROGRESS`. The key question is whether session-specific information (workspace paths, git branches, etc.) justifies a separate active sessions command, or if enhanced task listing would be more appropriate.

## References

- ✅ Task #229: Evaluate mandatory task-session association requirement (**COMPLETED**)
- Analysis files: `analysis/task-229-session-task-association-analysis.md`
- Implementation status: `analysis/task-229-implementation-status.md`
- Strategic recommendation: `analysis/strategic-recommendation.md`
- Current implementation: `src/adapters/shared/commands/session/basic-commands.ts`
- Task #229 PR: `process/tasks/229/pr.md`
