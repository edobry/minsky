# Task #010: Enhance `git pr` Command to Create GitHub PRs and Update Task Status

> **OBSOLETE**: This task has been superseded by architectural changes introduced in tasks #092 (Add Session PR Command) and #025 (Add PR Merging Commands for Session Workflow). The functionality described here has been reimplemented with a different architecture that better aligns with the session-first workflow.

## Context

Currently, the `minsky git pr` command generates a markdown document containing commit history and file changes for the current or specified branch. However, it only outputs this information to the console and doesn't actually create a GitHub PR. Additionally, it doesn't update the task status to reflect that the work is now in review.

To further streamline the development workflow, especially for junior engineers and AI agents, an enhanced `minsky git pr` command should:

1. Generate an AI-summarized PR description based on the commit history
2. Create an actual GitHub PR using the GitHub API
3. Update the associated task's status to "IN-REVIEW"
4. Auto-generate PR titles in conventional commits format

This enhancement will complete the end-to-end workflow from task creation to PR submission, making the entire process more efficient and automated.

## Requirements

1. **Enhanced CLI Behavior**

   - Updated command signature:
     ```
     minsky git pr [--session <session-name>] [--repo <repo-path>] [--branch <branch>] [--create] [--summarize] [--task <task-id>] [--title <title>] [--debug]
     ```
   - New options:
     - `--create`: Create an actual GitHub PR (default: false)
     - `--summarize`: Generate an AI-summarized PR description (default: false)
     - `--task <task-id>`: Task ID to associate with the PR (optional if in an active session)
     - `--title <title>`: Title for the PR (optional, will be AI-generated if not provided)

2. **Contextual Awareness**

   - If no session name or task ID is provided:
     - Automatically detect if running within an active session directory
     - Extract the session name and associated task ID
     - Use this information for PR creation and task status updates
   - Provide clear output about which session/task was detected

3. **GitHub Integration**

   - Authenticate with GitHub using environment variables (`GITHUB_TOKEN`)
   - Determine the GitHub repository URL from the git remote configuration
   - Create a PR using the GitHub API with:
     - The generated or provided title
     - The markdown description (either full or AI-summarized)
     - The specified branch as the source and the appropriate base branch as the target

4. **AI PR Title Generation**

   - When no title is provided, generate a title in the conventional commits format:
     - `<type>(<scope>): <description>`
     - Type examples: feat, fix, docs, style, refactor, test, chore
     - Scope should be determined from the task or commits
     - Description should be concise and descriptive
   - Ensure the title follows best practices for PR titles

5. **AI PR Summarization**

   - Use an AI service to generate a concise summary of changes from:
     - The commit messages and descriptions
     - The list of modified files
     - Any provided PR.md file in the task directory
   - Format the summary to include:
     - A brief overview of changes
     - Key implementation details
     - Testing information
     - Any notes or caveats

6. **Task Status Update**

   - After successfully creating a PR, automatically update the associated task's status to "IN-REVIEW"
   - Use the existing `TaskService` domain module to update the status
   - Output a confirmation of the status change

7. **Error Handling and Feedback**

   - Handle authentication errors for GitHub API
   - Provide informative error messages for common issues
   - Add proper validation for all new options
   - Show a clear success message with the PR URL when created

8. **Documentation Update**
   - Update the minsky-workflow.mdc to include the enhanced PR workflow
   - Add clear examples for different use cases

## Implementation Steps

1. [ ] Update GitService in `src/domain/git.ts`:

   - [ ] Enhance the `pr` method to support the new options
   - [ ] Add methods for GitHub authentication and PR creation
   - [ ] Implement AI summarization and title generation functionality
   - [ ] Add optional task status updating

2. [ ] Update PR command in `src/commands/git/pr.ts`:

   - [ ] Add the new command line options
   - [ ] Implement automatic session/task detection when in a session directory
   - [ ] Update action handler to support new functionality
   - [ ] Add proper validation and error handling
   - [ ] Integrate with TaskService for task status updates

3. [ ] Add GitHub API integration:

   - [ ] Add necessary dependencies for GitHub API
   - [ ] Implement authentication and PR creation logic
   - [ ] Handle rate limiting and API errors

4. [ ] Implement AI title generation:

   - [ ] Extract commit types and scope from commit history
   - [ ] Design a prompt for generating conventional commit format titles
   - [ ] Implement the service integration
   - [ ] Validate the generated titles meet the format requirements

5. [ ] Implement AI PR summarization:

   - [ ] Research and select an appropriate AI service
   - [ ] Design the prompt for effective PR summarization
   - [ ] Implement the API integration
   - [ ] Format the results appropriately

6. [ ] Add session/task detection:

   - [ ] Detect if the command is run from within a session directory
   - [ ] Extract session details and associated task ID
   - [ ] Add fallbacks if detection fails

7. [ ] Add task status updating:

   - [ ] Link with the TaskService domain module
   - [ ] Update task status after successful PR creation
   - [ ] Add proper error handling for task updates

8. [ ] Add comprehensive tests:

   - [ ] Unit tests for the new functionality
   - [ ] Integration tests for GitHub API interactions
   - [ ] Test cases for different command arguments
   - [ ] Test automatic session detection
   - [ ] Mock AI service responses for testing

9. [ ] Update documentation:
   - [ ] Update README.md with the new functionality
   - [ ] Update minsky-workflow.mdc with new workflow steps
   - [ ] Update CLI help text

## Verification

- [ ] Can generate a PR markdown document with `minsky git pr`
- [ ] Can create an actual GitHub PR with `minsky git pr --create`
- [ ] Can generate an AI-summarized PR description with `minsky git pr --summarize`
- [ ] Can create a PR with an AI-summarized description using `minsky git pr --create --summarize`
- [ ] Can automatically detect the current session and task when run from a session directory
- [ ] Can generate a conventional commit format PR title automatically
- [ ] Can associate a PR with a task using `minsky git pr --task <task-id>`
- [ ] Task status is automatically updated to "IN-REVIEW" after PR creation
- [ ] GitHub PR includes the proper title, description, source branch, and target branch
- [ ] Appropriate error messages are shown for authentication or API issues
- [ ] All tests pass
- [ ] Documentation and CLI help text are updated
- [ ] minsky-workflow.mdc is updated with the new workflow

## Notes

- This enhancement completes the end-to-end workflow from task creation to PR submission
- The AI-generated titles in conventional commits format ensure consistency across PRs
- Automatic session detection simplifies the command for users working within a task session
- The AI summarization feature will make PRs more consistent and readable
- Integration with GitHub streamlines the development process
- Automatic task status updates ensure the task tracking system remains accurate
- This command is particularly helpful for junior engineers and AI agents who may not be familiar with GitHub's PR process
- Consider future enhancements like supporting other Git hosting platforms (GitLab, Bitbucket) or adding PR templates
