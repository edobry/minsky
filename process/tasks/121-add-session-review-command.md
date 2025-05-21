# Task #121: Add "session review" Command for PR Review

## Context

Currently, Minsky provides a PR workflow with `git summary`, `git prepare-pr`, and `session pr` commands that help users create PRs. However, there's no easy way to review all the salient information about a PR that's been prepared, especially in a consolidated view. Users need to manually gather information from various sources to get a complete picture of the PR.

## Problem Statement

When reviewing a PR prepared with `git prepare-pr` or `session pr`, users need to see:

1. Task specification (requirements)
2. PR description (from the commit message)
3. The complete diff of changes
4. Any other relevant PR metadata

Currently, this requires running multiple commands and piecing together the information, which is time-consuming and error-prone.

## Requirements

Implement a `session review` command that:

1. Helps review a prepared PR by gathering and displaying all relevant information
2. Takes the following parameters:

   - Session name (optional, will try to detect current session if not provided)
   - Output format (console, default) or file path (optional)
   - PR branch name (optional, will detect from session if not provided)

3. Gathers and outputs:

   - Task specification (if session is associated with a task)
   - PR description (from the merge commit message if using `prepare-pr`)
   - Full diff of changes
   - PR metadata (branch names, commit count, etc.)

4. Supports different output modes:

   - Console output (default)
   - File output (when `--output <file>` is specified)
   - JSON output (when `--json` flag is used)

5. Integrates with the existing PR workflow:
   - Works for PRs created with both `git prepare-pr` and `session pr`
   - Can be run in any workspace (main or session)

## Implementation Plan

1. Create a new command `session review` in the CLI adapter
2. Implement the domain logic in a new function `sessionReviewFromParams`
3. Reuse existing utilities to:
   - Detect current session
   - Retrieve task specification
   - Extract PR description from merge commit
   - Generate diff output
4. Format the output in a clear, readable way
5. Add appropriate tests for the new functionality

## Command Usage

```bash
# Review current session PR
minsky session review

# Review specific session PR
minsky session review my-feature

# Review current session PR and output to file
minsky session review --output pr-review.md

# Get PR review data as JSON
minsky session review --json
```

## Current Status

Implementation is in progress:

1. ✅ Task specification created
2. ✅ Added entry to CHANGELOG.md
3. ✅ Started implementing `sessionReviewFromParams` function in the domain layer
4. ❌ Encountered TypeScript errors that need to be fixed:
   - Issues with return type of `execInRepository` (returns string, not {stdout})
   - Problems accessing `getTaskSpecData` method
   - Potential undefined values in string operations

## Remaining Work

1. Fix TypeScript errors in the current implementation
2. Complete the implementation of `sessionReviewFromParams` function
3. Add the `session review` command to the CLI adapter
4. Create a shared command entry in the command registry
5. Implement proper error handling for edge cases (missing PR, no task association, etc.)
6. Add tests for the new functionality
7. Update documentation to include the new command
8. Prepare PR for review

## Acceptance Criteria

- [ ] Command successfully retrieves and displays task specification for the PR
- [ ] Command successfully retrieves and displays PR description
- [ ] Command successfully generates and displays diff of changes
- [ ] Command handles both prepared PRs and regular branches
- [ ] Command works correctly from both main and session workspaces
- [ ] Command supports output to console (default) and file
- [ ] Command has proper error handling for missing sessions, PRs, etc.
- [ ] Command is well-tested with unit and integration tests
- [ ] Documentation is updated to include the new command 
