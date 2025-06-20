# Task #139: Add Session Context Autodetection to Minsky CLI Commands

## Status
TODO

## Priority
Medium

## Summary
Improve Minsky CLI UX by making session commands automatically detect the current session context when run from within a session workspace.

## Description
Currently, session commands like `minsky session update` require explicit `--session` or `--task` flags even when run from within a session workspace directory. This creates unnecessary friction in the workflow.

**Problem**: When working in `/Users/edobry/.local/state/minsky/git/local-minsky/sessions/task#138`, running `minsky session update` fails with "Session name is required" instead of autodetecting that we're in the `task#138` session.

## Requirements

### Core Features
- [ ] Detect session workspace from current working directory
- [ ] Extract session name from directory path pattern (`/sessions/{session-name}`)
- [ ] Auto-apply session context to relevant commands when detected
- [ ] Fall back to current behavior when not in a session workspace

### Affected Commands
- [ ] `minsky session update` - should autodetect current session
- [ ] `minsky session get` - should show current session when no args
- [ ] `minsky git pr` - should autodetect task ID from session
- [ ] Other session-scoped commands

### Implementation Details
- [ ] Create session context detection utility function
- [ ] Add session context detection to CLI command initialization
- [ ] Update command schemas to make session/task parameters optional when context is detected
- [ ] Add logging/debug output showing detected session context

### Error Handling
- [ ] Clear error messages when session detection fails
- [ ] Graceful fallback to explicit parameters
- [ ] Validation that detected context is correct

## Acceptance Criteria
1. When in a session workspace, `minsky session update` works without flags
2. Session context detection works for all session path patterns
3. Commands still work with explicit flags (backwards compatibility)
4. Clear feedback when session context is auto-detected vs explicitly provided
5. Proper error handling when session context is ambiguous

## Technical Notes
- Session workspace pattern: `**/sessions/{session-name}/`
- Git branch should match session name in most cases
- Consider both directory name and git branch for validation

## Estimated Effort
Medium (4-6 hours)

## Related Tasks
- Part of broader CLI UX improvements
- Related to session management workflow enhancements 
