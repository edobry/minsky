/**
 * Task Rule Templates
 *
 * Contains TASK_IMPLEMENTATION_WORKFLOW_TEMPLATE and TASK_STATUS_PROTOCOL_TEMPLATE.
 */

import { type RuleTemplate } from "../rule-template-service";

/**
 * Template for Task Implementation Workflow
 */
export const TASK_IMPLEMENTATION_WORKFLOW_TEMPLATE: RuleTemplate = {
  id: "task-implementation-workflow",
  name: "Task Implementation Workflow",
  description: "Comprehensive workflow for implementing tasks from creation to completion",
  tags: ["task", "implementation", "workflow"],
  generateContent: (context) => {
    const { helpers } = context;

    return `# Task Implementation Workflow

This rule provides a comprehensive workflow for implementing tasks from start to completion, including all required status updates and checkpoints.

## Prerequisites

Before starting any task implementation, ensure:

1. **Task exists and is properly specified** - Use ${helpers.command("tasks.get")} to verify
2. **Task status is appropriate** - Check with ${helpers.command("tasks.status.get")}
3. **You understand the requirements** - Review task specification thoroughly

## Implementation Workflow

### Phase 1: Task Preparation

1. **Verify Task Status**
   - Check current status: ${helpers.command("tasks.status.get")}
   - Ensure task is in appropriate state for implementation
   - If not in correct state, update: ${helpers.command("tasks.status.set")}

2. **Create or Resume Session**
   - Check existing sessions: ${helpers.command("session.list")}
   - Create new session: ${helpers.command("session.start")}
   - Get session directory: ${helpers.command("session.dir")}

3. **Set Task Status to IN-PROGRESS**
   - Update status: ${helpers.command("tasks.status.set")} with status "IN-PROGRESS"
   - This signals that active work has begun

### Phase 2: Implementation

1. **Navigate to Session Workspace**
   - Use session directory from previous step
   - Verify you're in the correct workspace
   - All implementation must happen in session workspace

2. **Implement Requirements**
   - Follow task specification exactly
   - Write comprehensive tests for new functionality
   - Ensure all existing tests continue to pass
   - Document any design decisions or trade-offs

3. **Continuous Verification**
   - Run tests frequently during development
   - Check that requirements are being met
   - Address any issues immediately

### Phase 3: Completion Verification

1. **Final Testing**
   - Run complete test suite
   - Verify all new functionality works as specified
   - Ensure no regressions have been introduced

2. **Requirements Review**
   - Review original task specification
   - Confirm all requirements have been addressed
   - Check for any overlooked aspects

3. **Code Quality Check**
   - Review code for clarity and maintainability
   - Ensure proper error handling
   - Verify documentation is complete

### Phase 4: PR Preparation

1. **Update Task Status to IN-REVIEW**
   - Set status: ${helpers.command("tasks.status.set")} with status "IN-REVIEW"
   - This indicates implementation is complete and ready for review

2. **Create Pull Request**
   - Generate PR using session PR command: ${helpers.command("session.pr.create")}
   - Ensure PR description follows guidelines
   - Include task ID in PR title and description

3. **Final Verification**
   - Review PR content thoroughly
   - Ensure all changes are included
   - Verify task status is correctly updated

## Status Transition Protocol

| Current Status | Action Required | Command | Next Status |
|----------------|-----------------|---------|-------------|
| TODO | Start implementation | ${helpers.command("tasks.status.set")} | IN-PROGRESS |
| IN-PROGRESS | Complete implementation | ${helpers.command("tasks.status.set")} | IN-REVIEW |
| IN-REVIEW | Merge PR | Approve PR | DONE |
| BLOCKED | Resolve blocking issue | ${helpers.command("tasks.status.set")} | IN-PROGRESS |

## Quality Gates

Before moving to the next phase, ensure:

### Before IN-PROGRESS → IN-REVIEW
- [ ] All requirements implemented
- [ ] All tests passing
- [ ] Code quality acceptable
- [ ] Documentation complete

### Before IN-REVIEW → DONE
- [ ] PR created and properly described
- [ ] All feedback addressed
- [ ] Changes approved by reviewer
- [ ] PR merged successfully

## Common Issues and Solutions

### Implementation Issues

**Problem**: Requirements unclear or ambiguous
**Solution**: Update task specification before continuing, don't guess at requirements

**Problem**: Tests failing after changes
**Solution**: Fix tests immediately, don't accumulate technical debt

**Problem**: Scope creep during implementation
**Solution**: Create separate tasks for additional work, stay focused on current task

### Status Management Issues

**Problem**: Forgot to update task status
**Solution**: Check status regularly with ${helpers.command("tasks.status.get")}, update as needed

**Problem**: Task status doesn't match actual progress
**Solution**: Align status with actual state immediately using ${helpers.command("tasks.status.set")}

### Session Management Issues

**Problem**: Working in wrong directory
**Solution**: Always verify you're in session workspace before making changes

**Problem**: Changes not appearing in session
**Solution**: Ensure you created session properly and are in correct directory

## Integration with Other Rules

This workflow integrates with:

- **task-status-protocol**: For detailed status management procedures
- **session-first-workflow**: For session creation and navigation requirements
- **pr-preparation-workflow**: For PR creation and submission details
- **minsky-workflow-orchestrator**: For overall workflow context
- **tests**: For testing requirements and procedures

## Verification Checklist

Use this checklist to ensure proper workflow adherence:

- [ ] Task status checked and appropriate for implementation
- [ ] Session created and verified
- [ ] Task status updated to IN-PROGRESS at start
- [ ] All implementation done in session workspace
- [ ] Requirements thoroughly implemented
- [ ] Tests written and passing
- [ ] Task status updated to IN-REVIEW when complete
- [ ] PR created with proper description
- [ ] Task linked to PR appropriately`;
  },
  generateMeta: (context) => ({
    name: "Task Implementation Workflow",
    description: "Comprehensive workflow for implementing tasks from creation to completion",
    tags: ["task", "implementation", "workflow", "status"],
  }),
};

/**
 * Template for Task Status Protocol
 */
export const TASK_STATUS_PROTOCOL_TEMPLATE: RuleTemplate = {
  id: "task-status-protocol",
  name: "Task Status Protocol",
  description:
    "Procedures for checking and updating task status throughout the implementation lifecycle",
  tags: ["task", "status", "protocol"],
  generateContent: (context) => {
    const { helpers } = context;

    return `# Task Status Protocol

This rule defines the procedures for checking and updating task status throughout the implementation lifecycle.

## Status Values

Minsky uses the following task status values:

| Status | Meaning | When to Use |
|--------|---------|-------------|
| **TODO** | Task ready for implementation | Initial state for new tasks |
| **IN-PROGRESS** | Implementation actively underway | When starting implementation work |
| **IN-REVIEW** | Implementation complete, awaiting review | When submitting PR for review |
| **DONE** | Task fully completed and merged | After successful PR merge |
| **BLOCKED** | Implementation blocked by external factor | When unable to proceed |
| **CLOSED** | Task cancelled or no longer needed | When abandoning task |

## Status Commands

### Checking Status

**Get current status**: ${helpers.command("tasks.status.get")}
- Returns current status of specified task
- Essential before starting any work
- Use to verify status is appropriate for next action

**List tasks by status**: ${helpers.command("tasks.list")} with status filter
- Shows all tasks matching specific status
- Useful for finding work to do or reviewing progress

### Updating Status

**Set new status**: ${helpers.command("tasks.status.set")}
- Updates task to new status value
- Include reason/comment when helpful
- Always verify update was successful

## Status Transition Rules

### TODO → IN-PROGRESS
**When**: Starting implementation work
**Trigger**: Creating session and beginning implementation
**Command**: ${helpers.command("tasks.status.set")} with status "IN-PROGRESS"
**Requirements**:
- Task specification is clear and complete
- Session has been created for the task
- You are ready to begin implementation

### IN-PROGRESS → IN-REVIEW
**When**: Implementation complete, ready for review
**Trigger**: Creating pull request
**Command**: ${helpers.command("tasks.status.set")} with status "IN-REVIEW"
**Requirements**:
- All requirements implemented
- Tests written and passing
- PR created and properly described

### IN-REVIEW → DONE
**When**: Pull request approved and merged
**Trigger**: Successful PR merge
**Command**: Usually automatic, but can manually set with ${helpers.command("tasks.status.set")}
**Requirements**:
- PR has been reviewed and approved
- All tests passing in CI
- PR successfully merged to main branch

### Any Status → BLOCKED
**When**: Unable to proceed due to external factors
**Trigger**: Encountering blocking dependency or issue
**Command**: ${helpers.command("tasks.status.set")} with status "BLOCKED"
**Requirements**:
- Document the blocking factor
- Identify resolution path if possible
- Notify relevant stakeholders

### BLOCKED → IN-PROGRESS
**When**: Blocking issue resolved
**Trigger**: External dependency resolved or issue fixed
**Command**: ${helpers.command("tasks.status.set")} with status "IN-PROGRESS"
**Requirements**:
- Blocking factor has been resolved
- Implementation can proceed normally

### Any Status → CLOSED
**When**: Task no longer needed or cancelled
**Trigger**: Change in requirements or priorities
**Command**: ${helpers.command("tasks.status.set")} with status "CLOSED"
**Requirements**:
- Clear reason for closure
- Any partial work properly documented

## Status Verification Protocol

### Before Starting Work

1. **Check current status**: ${helpers.command("tasks.status.get")}
2. **Verify status is TODO or IN-PROGRESS**
3. **If not appropriate, investigate and resolve**
4. **Update to IN-PROGRESS when beginning**: ${helpers.command("tasks.status.set")}

### During Implementation

1. **Monitor status regularly**: ${helpers.command("tasks.status.get")}
2. **Keep status aligned with actual progress**
3. **Update to BLOCKED if issues arise**: ${helpers.command("tasks.status.set")}
4. **Document any status changes and reasons**

### Before PR Creation

1. **Verify implementation is complete**
2. **Update to IN-REVIEW**: ${helpers.command("tasks.status.set")}
3. **Ensure status change is successful**
4. **Proceed with PR creation only after status update**

### After PR Merge

1. **Verify status shows DONE**: ${helpers.command("tasks.status.get")}
2. **If not automatic, manually update**: ${helpers.command("tasks.status.set")}
3. **Confirm task is properly completed**

## Status Query Patterns

### Check Single Task
\`\`\`bash
${helpers.command("tasks.status.get")}
\`\`\`

### List Tasks by Status
\`\`\`bash
# Find tasks ready to work on
${helpers.command("tasks.list")}

# Find tasks in progress
${helpers.command("tasks.list")}

# Find blocked tasks
${helpers.command("tasks.list")}
\`\`\`

### Update Task Status
\`\`\`bash
# Start implementation
${helpers.command("tasks.status.set")}

# Mark for review
${helpers.command("tasks.status.set")}

# Mark as blocked with reason
${helpers.command("tasks.status.set")}
\`\`\`

## Status Automation

Some status transitions can be automated:

- **Session creation** can auto-update TO IN-PROGRESS
- **PR creation** can auto-update to IN-REVIEW
- **PR merge** can auto-update to DONE

Always verify automated updates occurred correctly.

## Common Status Issues

### Issue: Status stuck in wrong state
**Solution**: Use ${helpers.command("tasks.status.set")} to correct it, then investigate why it got wrong

### Issue: Status not updating after PR merge
**Solution**: Manually update with ${helpers.command("tasks.status.set")}, check automation settings

### Issue: Multiple people working on same task
**Solution**: Check status before starting work, coordinate with team on assignment

### Issue: Unclear when to update status
**Solution**: Follow the transition rules above, when in doubt check current status and update accordingly

## Integration with Workflow

Status management integrates with:

- **task-implementation-workflow**: Status updates at each phase
- **pr-preparation-workflow**: Status transition during PR creation
- **minsky-workflow-orchestrator**: Overall workflow context

## Verification Checklist

Before considering status management complete:

- [ ] Current status checked and verified
- [ ] Status appropriate for planned action
- [ ] Status updated when starting new phase
- [ ] Status changes documented with reasons
- [ ] Status transitions follow defined rules
- [ ] Final status reflects actual completion state`;
  },
  generateMeta: (context) => ({
    name: "Task Status Protocol",
    description:
      "Procedures for checking and updating task status throughout the implementation lifecycle",
    tags: ["task", "status", "protocol", "workflow"],
  }),
};

export const TASK_TEMPLATES: RuleTemplate[] = [
  TASK_IMPLEMENTATION_WORKFLOW_TEMPLATE,
  TASK_STATUS_PROTOCOL_TEMPLATE,
];
