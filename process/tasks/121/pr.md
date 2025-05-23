# feat(#121): Add session review command for PR review

## Summary
This PR implements task #121, adding a new `session review` command that provides a consolidated view of task specifications, PR descriptions, and code changes. It helps developers efficiently review PRs by gathering all relevant information in one place.

## Motivation & Context
PR reviews currently require accessing multiple sources of information (task spec, PR description, diffs) across different tools and interfaces. This change streamlines the review process by gathering all relevant information in a single comprehensive view.

## Design Approach
We designed the feature following the established three-layer architecture:
1. **Domain layer**: Core implementation with proper dependency injection
2. **Adapter layer**: CLI interface and shared command implementation
3. **Schema layer**: Standardized parameter validation

The implementation supports multiple detection and output modes with proper error handling and a consistent user experience.

## Key Changes
- Added `sessionReviewFromParams` function to the domain layer with:
  - Auto-detection of current session when no parameters provided
  - Support for session name or task ID parameters
  - Task specification retrieval
  - PR description retrieval from git commit messages
  - Diff statistics and full diff generation
- Added CLI command implementation with formatted output options
- Added schema definition for `SessionReviewParams`
- Implemented shared command adapter for the review command
- Added basic tests for the review functionality
- Updated CLI interface to include the new command

## Testing
- Added unit tests that verify:
  - Review by session name functionality
  - Review by task ID functionality
  - Auto-detection of current session
  - Error handling for invalid sessions
  - Error handling when no session can be determined

## Example Usage

Session review can be called in multiple ways:

```bash
# Review current session (auto-detected)
minsky session review

# Review by session name
minsky session review task#121

# Review by task ID
minsky session review --task 121

# Save review to a file
minsky session review --output review.md

# Output in JSON format
minsky session review --json
```

The command's output includes:
- Task specification from the associated task
- PR description from the PR branch commit message
- Detailed diff statistics (files changed, insertions, deletions)
- Full diff showing all changes
