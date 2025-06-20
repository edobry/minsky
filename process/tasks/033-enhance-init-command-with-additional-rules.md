# Enhance Minsky Init Command with Additional Rules

## Context

The current `minsky init` command establishes a basic project structure with minimal rules (primarily minsky-workflow.mdc). However, for proper Minsky workflow enforcement, additional rules are needed to guide users through the complete development process. Without these rules, users may not follow the correct workflow patterns, leading to inconsistencies, errors, and workflow violations.

## Requirements

1. **Update the init command** to include the following additional rules:

   - `creating-tasks.mdc`: Task specification format, creation process, and distinction between task creation and implementation
   - `workspace-detection.mdc`: Rules for identifying main workspace vs session workspace
   - `session-management.mdc`: Session creation, navigation, and lifecycle management
   - `task-operations.mdc`: Task status transitions, tracking, and linking tasks to sessions
   - `pr-description-guidelines.mdc`: Format for pull request documentation and integration with task completion workflow

2. **Rule content generation**:

   - Create standardized content for each rule based on current Minsky best practices
   - Ensure rules are comprehensive but concise
   - Include examples and clear guidance in each rule

3. **Rule installation logic**:

   - Update the domain logic to write these rules to the appropriate location
   - Support both Cursor and generic rule formats
   - Handle file existence and overwrite confirmations consistently

4. **Testing and validation**:
   - Ensure rules are properly written during initialization
   - Verify rule content for accuracy and completeness
   - Test with both rule format options

## Implementation Steps

1. [ ] Create template content for each new rule:

   - [ ] `creating-tasks.mdc`: Format and process for creating task specifications
   - [ ] `workspace-detection.mdc`: Guidelines for workspace identification
   - [ ] `session-management.mdc`: Session lifecycle rules
   - [ ] `task-operations.mdc`: Task status and tracking guidelines
   - [ ] `pr-description-guidelines.mdc`: PR documentation standards

2. [ ] Update domain logic in `src/domain/init.ts`:

   - [ ] Add new rule template constants
   - [ ] Enhance `writeRules` function to include additional rules
   - [ ] Implement proper error handling for rule writing failures

3. [ ] Update CLI command in `src/commands/init/init.ts`:

   - [ ] Update help text to mention additional rules
   - [ ] Add option to selectively disable certain rules if needed

4. [ ] Add tests:

   - [ ] Test rule content generation
   - [ ] Test rule installation with Cursor format
   - [ ] Test rule installation with generic format
   - [ ] Test error handling for existing files

5. [ ] Update documentation:
   - [ ] Update README.md with information about the enhanced rule set
   - [ ] Update CHANGELOG.md

## Verification

- [ ] Running `minsky init` creates all specified rule files
- [ ] Rules are written to the correct location based on format option
- [ ] Rule content is comprehensive and follows best practices
- [ ] Error handling works correctly for existing files
- [ ] All tests pass
- [ ] Documentation is updated to reflect the changes

## Dependencies/References

- Current `init` command implementation in `src/commands/init/init.ts`
- Existing rule templates and content
- Minsky best practices for task management, session handling, and PR generation
