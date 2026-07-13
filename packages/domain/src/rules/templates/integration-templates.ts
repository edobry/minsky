/**
 * Integration Rule Templates
 *
 * Contains PR_PREPARATION_WORKFLOW_TEMPLATE.
 */

import { type RuleTemplate } from "../rule-template-service";

/**
 * Template for PR Preparation Workflow
 */
export const PR_PREPARATION_WORKFLOW_TEMPLATE: RuleTemplate = {
  id: "pr-preparation-workflow",
  name: "PR Preparation Workflow",
  description: "Complete workflow for preparing, creating, and managing pull requests",
  tags: ["pr", "pullrequest", "workflow"],
  generateContent: (context) => {
    const { helpers } = context;

    return `# PR Preparation Workflow

This rule provides a complete workflow for preparing, creating, and managing pull requests in the Minsky system.

## Overview

Pull requests are the mechanism for integrating completed work from sessions back into the main codebase. The PR workflow ensures:

- Proper review of all changes
- Integration with task management
- Quality assurance before merge
- Documentation of changes

## Prerequisites

Before creating a PR, ensure:

1. **Implementation is complete** - All task requirements met
2. **Tests are passing** - Full test suite runs successfully
3. **Task status is correct** - Should be IN-REVIEW before PR creation
4. **Session is current** - Session updated with latest changes

## PR Creation Process

### Step 1: Pre-PR Verification

**Check task status**: ${helpers.command("tasks.status.get")}
- Verify task is in appropriate state for PR creation
- Update to IN-REVIEW if not already: ${helpers.command("tasks.status.set")}

**Verify session state**: ${helpers.command("session.get")}
- Confirm session is properly configured
- Check that all changes are committed
- Ensure session is up to date

### Step 2: Create Pull Request

**Generate PR from session**: ${helpers.command("session.pr.create")}
- Creates PR from session branch to main branch
- Automatically links PR to associated task
- May update task status to IN-REVIEW

**Provide PR details**:
- Use descriptive title including task ID
- Write comprehensive description of changes
- Include testing information
- Reference any relevant issues or dependencies

### Step 3: PR Content Verification

After PR creation:

1. **Review PR description** - Ensure it follows guidelines
2. **Check file changes** - Verify all intended changes included
3. **Confirm task linkage** - PR should reference task ID
4. **Validate build status** - Ensure CI/CD passes

## PR Description Format

Follow this structure for PR descriptions:

\`\`\`markdown
# <type>(#<task-id>): <Short description>

## Summary
Brief description of what was changed and why.

## Changes
### Added
- List new features or functionality

### Changed
- List modifications to existing functionality

### Fixed
- List bugs or issues resolved

## Testing
Description of testing performed.

## Checklist
- [x] All requirements implemented
- [x] Tests written and passing
- [x] Documentation updated
\`\`\`

## PR Types

Use these prefixes for PR titles:

- **feat**: New feature
- **fix**: Bug fix
- **docs**: Documentation changes
- **style**: Code style changes
- **refactor**: Code refactoring
- **perf**: Performance improvements
- **test**: Test additions or modifications
- **chore**: Build process or tool changes

## PR Management Commands

### PR Creation
**Create PR from session**: ${helpers.command("session.pr.create")}
- Primary method for creating PRs
- Handles task integration automatically
- Manages branch and status updates

### PR Information
**Get session PR info**: ${helpers.command("session.get")}
- Shows PR status for session
- Displays PR URL and details
- Indicates merge status

## PR Review Process

### For PR Authors

1. **Respond to feedback promptly**
2. **Make requested changes in session workspace**
3. **Push updates to session branch**
4. **Re-request review after changes**

### For PR Reviewers

1. **Review code changes thoroughly**
2. **Verify requirements are met**
3. **Check test coverage and quality**
4. **Provide constructive feedback**
5. **Approve when satisfied with changes**

## PR Merge Process

### Automated Merge
When using Minsky's integrated workflow:
- PR merge can trigger automatic task status update to DONE
- Session cleanup may be automated
- Branch deletion handled automatically

### Manual Verification
After PR merge:

1. **Verify task status**: ${helpers.command("tasks.status.get")}
2. **Confirm changes in main branch**
3. **Update task status if needed**: ${helpers.command("tasks.status.set")}

## Common PR Scenarios

### Scenario 1: Standard Feature PR

\`\`\`bash
# 1. Verify implementation complete and tests passing
cd $(${helpers.command("session.dir")})

# 2. Update task status to IN-REVIEW
${helpers.command("tasks.status.set")}

# 3. Create PR from session
${helpers.command("session.pr.create")}
\`\`\`

### Scenario 2: Bug Fix PR

\`\`\`bash
# 1. Ensure fix is complete and tested
cd $(${helpers.command("session.dir")})

# 2. Update task status
${helpers.command("tasks.status.set")}

# 3. Create PR with fix prefix
${helpers.command("session.pr.create")}
\`\`\`

### Scenario 3: Documentation PR

\`\`\`bash
# 1. Verify documentation changes
cd $(${helpers.command("session.dir")})

# 2. Set appropriate status
${helpers.command("tasks.status.set")}

# 3. Create docs PR
${helpers.command("session.pr.create")}
\`\`\`

## PR Best Practices

### Content Guidelines
- **Keep PRs focused** - One task per PR
- **Write clear descriptions** - Explain what and why
- **Include testing info** - How changes were verified
- **Reference task ID** - Link to original requirement

### Technical Guidelines
- **Ensure tests pass** - All CI/CD checks green
- **Keep changes minimal** - Only what's needed for task
- **Handle conflicts promptly** - Resolve merge conflicts quickly
- **Update documentation** - Keep docs current with changes

### Process Guidelines
- **Create PR when ready** - Don't create draft PRs prematurely
- **Respond to reviews quickly** - Keep momentum going
- **Test final version** - Verify changes after addressing feedback
- **Clean up after merge** - Close related issues, update status

## Troubleshooting

### Problem: PR creation fails
**Solution**: Check session status with ${helpers.command("session.get")}, ensure all changes committed

### Problem: PR not linked to task
**Solution**: Verify task ID in PR title and description, update if needed

### Problem: Tests failing in PR
**Solution**: Run tests in session workspace, fix failures before requesting review

### Problem: Merge conflicts
**Solution**: Update session with ${helpers.command("session.update")}, resolve conflicts, push updates

## Integration Points

This workflow integrates with:

- **task-implementation-workflow**: PR creation is final phase of implementation
- **task-status-protocol**: Status updates during PR lifecycle
- **pr-description-guidelines**: Detailed formatting requirements

## Verification Checklist

Before creating PR:

- [ ] All requirements implemented
- [ ] Tests written and passing
- [ ] Task status is IN-REVIEW
- [ ] Session is up to date
- [ ] Changes are committed and pushed
- [ ] PR title includes task ID
- [ ] PR description is complete and follows format`;
  },
  generateMeta: (context) => ({
    name: "PR Preparation Workflow",
    description: "Complete workflow for preparing, creating, and managing pull requests",
    tags: ["pr", "pullrequest", "git", "workflow"],
  }),
};

export const INTEGRATION_TEMPLATES: RuleTemplate[] = [PR_PREPARATION_WORKFLOW_TEMPLATE];
