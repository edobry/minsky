# Refactor `minsky-workflow.mdc` Rule into Smaller, Focused Rules

## Summary

This PR refactors the monolithic minsky-workflow.mdc rule into six smaller, more focused rules. Each rule addresses a specific aspect of the workflow, making them easier to understand, apply, and maintain. The original rule has been deprecated with references to the new rule system.

## Changes

### Added

- Created six new cursor rules:
  1. **minsky-workflow-orchestrator** - Provides an overview of the workflow system, links to other rules, and serves as the entry point
  2. **minsky-cli-usage** - CLI command reference and verification protocol
  3. **minsky-session-management** - Session creation, navigation, and management procedures
  4. **task-implementation-workflow** - Step-by-step task implementation process
  5. **task-status-protocol** - Status checking, updating, and verification procedures
  6. **pr-preparation-workflow** - PR creation and submission guidelines

### Changed

- Added cross-references between rules to improve navigation
- Deprecated the original monolithic minsky-workflow rule with references to the new rule system
- Updated CHANGELOG.md with the refactoring information

### Organization Improvements

- Each rule focuses on a specific workflow domain
- Rules include clear cross-references to other related rules
- The orchestrator rule provides a high-level overview and serves as an entry point

## Testing

The new rule files have been created and tested with basic validation of:
- Proper YAML frontmatter
- Correct cross-references between rules
- Valid Markdown formatting

## Checklist

- [x] All new rules created with proper frontmatter and content
- [x] Cross-references between rules implemented correctly
- [x] Original rule marked as deprecated with references to new rules
- [x] CHANGELOG.md updated with the refactoring information
- [x] README or documentation updated (PR markdown documentation created) 
