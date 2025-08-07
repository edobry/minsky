# Improve Session PR Command Output and Body Generation

## Status

BACKLOG

## Priority

MEDIUM

## Description

Improve the session pr command to provide better output and generate meaningful PR body content.

**Current Issues:**

1. **Missing PR Body**: The session pr command outputs 'body: undefined' instead of generating a meaningful PR description
2. **Unclear Output Format**: The command output is not user-friendly and doesn't clearly indicate next steps
3. **No Content Generation**: Unlike git pr command, session pr doesn't auto-generate PR content from commits/changes

**Requirements:**

1. **Generate PR Body Content**:

   - Auto-generate PR description from commit messages in the session branch
   - Include task specification content if session is associated with a task
   - Summarize key changes made in the session

2. **Improve Output Format**:

   - Provide clear, formatted output showing PR details
   - Include actionable next steps (e.g., how to create the actual PR)
   - Show preview of generated PR content

3. **Better Error Handling**:

   - Provide helpful error messages when PR generation fails
   - Guide users on how to resolve common issues

4. **Consistency with Git PR Command**:
   - Align session pr output format with git pr command where appropriate
   - Ensure both commands provide similar level of detail and usefulness

**Acceptance Criteria:**

- Session pr command generates meaningful PR body content
- Output is well-formatted and user-friendly
- Command provides clear next steps for creating the PR
- Error messages are helpful and actionable

## Requirements

### Functional Requirements

1. **PR Body Generation**

   - Auto-generate meaningful PR description from commit messages in session branch
   - Include task specification content if session is associated with a task
   - Summarize key changes made during the session
   - Format content according to conventional PR description standards

2. **Output Format Improvements**

   - Display clear, formatted output showing PR details (title, body, branch info)
   - Include actionable next steps for creating the actual PR
   - Show preview of generated PR content before use
   - Maintain consistency with existing `git pr` command output format

3. **Error Handling**

   - Provide helpful error messages when PR generation fails
   - Guide users on resolving common issues (no commits, no task association, etc.)
   - Handle edge cases gracefully (empty sessions, malformed commit messages)

4. **Integration Requirements**
   - Align with existing `git pr` command functionality where appropriate
   - Maintain backward compatibility with current session pr command usage
   - Support both task-associated and standalone sessions

### Technical Requirements

1. **Content Generation Logic**

   - Parse commit messages from session branch to extract meaningful changes
   - Extract and format task specification content when available
   - Generate concise but comprehensive PR descriptions
   - Handle different commit message formats and conventions

2. **Output Formatting**
   - Use consistent formatting with other Minsky CLI commands
   - Support both human-readable and machine-readable output formats
   - Include proper line breaks and markdown formatting in generated content

## Success Criteria

### Acceptance Criteria

1. **Content Quality**

   - [ ] Session pr command generates non-empty, meaningful PR body content
   - [ ] Generated content includes relevant information from commits and task specs
   - [ ] PR descriptions follow conventional format and are well-structured
   - [ ] Content is concise but comprehensive enough for reviewers

2. **User Experience**

   - [ ] Command output is clear and well-formatted
   - [ ] Users receive actionable next steps after running the command
   - [ ] Error messages are helpful and guide users toward resolution
   - [ ] Command performance is acceptable (completes within 5 seconds)

3. **Integration**
   - [ ] Output format is consistent with `git pr` command where applicable
   - [ ] Command works correctly for both task-associated and standalone sessions
   - [ ] Backward compatibility is maintained for existing usage patterns
   - [ ] Integration with existing session management workflow is seamless

### Definition of Done

- [ ] All functional requirements implemented and tested
- [ ] Command generates meaningful PR content for various session types
- [ ] Error handling covers common failure scenarios
- [ ] Documentation updated to reflect new functionality
- [ ] Manual testing confirms improved user experience
- [ ] No regressions in existing session pr command functionality
