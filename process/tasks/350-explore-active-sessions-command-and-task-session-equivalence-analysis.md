# Explore Active Sessions Command and Task/Session Equivalence Analysis

## Status

TODO

## Priority

MEDIUM

## Description

Explore the concept of adding a command to list "active sessions" and analyze its relationship to the ongoing Task #229 task/session equivalence exploration to determine if such a command would provide value or become redundant.

## Background

The current Minsky CLI includes `minsky session list` which shows all sessions, but there's no specific command to filter for "active" sessions. Concurrently, Task #229 is exploring mandatory task-session association through a "task/session equivalence" approach that could potentially make active sessions redundant with active tasks.

## Current State Analysis

### Existing Session Management

- **`minsky session list`**: Lists all sessions with optional verbose mode
- **Session-task relationship**: Sessions can optionally have a `taskId` field
- **Task status integration**: Sessions with tasks automatically update task status to `IN_PROGRESS`
- **Session lifecycle**: Sessions exist until "approved" (merged via PR)

### Task #229 Context

Task #229 (currently IN-PROGRESS) is exploring:
- Mandatory task-session association through auto-creation
- Hybrid approach where session descriptions automatically create lightweight tasks
- Three-phase adoption strategy to move toward task/session equivalence
- Strategic recommendation for structured session documentation

## Investigation Objectives

### 1. Define "Active Sessions" Criteria

**Current Architecture:**
- [ ] Analyze what constitutes an "active" session in the current system
- [ ] Evaluate sessions without associated tasks vs. sessions with tasks
- [ ] Determine if "active" means "not yet approved/merged" vs. "currently being worked on"

**Future Architecture (if Task #229 succeeds):**
- [ ] Understand how "active sessions" would relate to tasks with `IN_PROGRESS` status
- [ ] Assess whether active sessions = active tasks under task/session equivalence

### 2. Analyze Current Session Listing Functionality

- [ ] Review `minsky session list` implementation and capabilities
- [ ] Identify what filtering options currently exist
- [ ] Assess whether session status tracking exists or would need to be added

### 3. Evaluate Redundancy with Task #229

- [ ] Compare active sessions concept with Task #229's task/session equivalence findings
- [ ] Determine if mandatory task association makes active sessions redundant
- [ ] Assess timeline overlap and implementation dependencies

### 4. Assess Command Value Proposition

**Potential Benefits:**
- [ ] Faster workflow for developers to see work-in-progress
- [ ] Better visibility into resource allocation and active work
- [ ] Cleaner interface than filtering full session list

**Potential Redundancy:**
- [ ] If task/session equivalence is implemented, `minsky tasks list --status IN_PROGRESS` might be equivalent
- [ ] Current `minsky session list` might be sufficient with filters
- [ ] Additional complexity without proportional benefit

## Implementation Considerations

### Scenario 1: Implement Before Task #229 Completion

If active sessions command provides immediate value:
- [ ] Add `--active` flag to existing `minsky session list` command
- [ ] Define active criteria (e.g., sessions not yet approved/merged)
- [ ] Consider this a bridge solution until task/session equivalence

### Scenario 2: Wait for Task #229 Resolution

If redundancy is likely:
- [ ] Monitor Task #229 progress and findings
- [ ] Reassess need based on final task/session equivalence design
- [ ] Consider alternative solutions like enhanced task list filtering

### Scenario 3: Hybrid Approach

If both provide value:
- [ ] Design active sessions command to complement task management
- [ ] Ensure consistency with Task #229's strategic direction
- [ ] Plan for smooth transition if task/session equivalence is adopted

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

- **Task #229**: Task/session equivalence evaluation (IN-PROGRESS)
- **Current session management**: Understanding of existing `minsky session list` functionality
- **Task status system**: Understanding of task lifecycle and status management

## Notes

This exploration should be closely coordinated with Task #229 to avoid duplicating effort and ensure architectural consistency. The goal is to determine whether active sessions provide unique value or would become redundant under the task/session equivalence model.

## References

- Task #229: Evaluate mandatory task-session association requirement
- Analysis files: `analysis/task-229-session-task-association-analysis.md`
- Strategic recommendation: `analysis/strategic-recommendation.md`
- Current implementation: `src/adapters/shared/commands/session/basic-commands.ts`
