---
name: commit-push-workflow
description: REQUIRED for ALL git commits - must push immediately after committing to ensure synchronization
globs: ["**/*"]
alwaysApply: true
---

# Commit-Push Workflow

## Rule Name: commit-push-workflow

## Description
**ALWAYS push immediately after committing any changes.** This rule must be used whenever committing changes to ensure your work is properly synchronized and available to others.

## Key Requirements

1. **Immediate Push Requirement**: After every `git commit` operation, IMMEDIATELY perform a `git push` operation without delay.

2. **No Intermediate Tasks**: Do not perform any other tasks between committing and pushing.

3. **Verification**: After pushing, verify that the push was successful by checking the terminal output.

## Workflow Checklist

For every code change:

- ✓ Stage changes with `git add`
- ✓ Commit changes with descriptive message using `git commit`
- ✓ **IMMEDIATELY** push changes using `git push`
- ✓ Verify push success in terminal output

## Example:

```bash
git add src/domain/session.test.ts
git commit -m "Fix session test mocking issues"
git push  # Execute immediately after committing
```

## Rationale

- **Prevents Synchronization Issues**: Ensures all changes are immediately available in the shared repository
- **Reduces Conflicts**: Minimizes the window where local state diverges from remote
- **Improves Collaboration**: Makes your changes visible to collaborators without delay
- **Prevents Data Loss**: Protects against local environment issues by storing changes remotely
- **Simplifies Workflow**: Establishes a consistent, repeatable pattern for code changes

## Violations

The following are considered violations of this rule:

- Committing changes without pushing
- Performing other operations between commit and push
- Accumulating multiple commits before pushing
- Pushing only at the end of a work session

**Remember**: The commit-push sequence should be treated as a single atomic operation, never to be separated. 
