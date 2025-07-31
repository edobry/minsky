# Migration Guide: Session PR Command Restructure (Task 359)

## Overview

**Breaking Change**: The `session pr` command has been restructured into explicit subcommands for better organization and future extensibility.

## What Changed

### Old Command Structure (DEPRECATED)
```bash
# This no longer works
minsky session pr --title "feat: Add feature" --body "Description"
```

### New Command Structure (Required)
```bash
# Use explicit subcommands
minsky session pr create --title "feat: Add feature" --body "Description"
minsky session pr list
minsky session pr get [session-name] --task <id>
```

## Migration Steps

### 1. Update Create Commands

**Before (Deprecated):**
```bash
minsky session pr --title "feat: Add authentication" --body "Implements JWT auth"
minsky session pr --title "fix: Bug fix" --body-path process/tasks/123/pr.md
minsky session pr --debug --skip-update
```

**After (Required):**
```bash
minsky session pr create --title "feat: Add authentication" --body "Implements JWT auth"  
minsky session pr create --title "fix: Bug fix" --body-path process/tasks/123/pr.md
minsky session pr create --debug --skip-update
```

### 2. New List Functionality

**New capability not available before:**
```bash
# List all session PRs
minsky session pr list

# Filter by session
minsky session pr list --session feat-auth

# Filter by task
minsky session pr list --task 123

# Filter by status
minsky session pr list --status open

# JSON output
minsky session pr list --json

# Detailed output
minsky session pr list --verbose
```

### 3. New Get Functionality

**New capability not available before:**
```bash
# Get PR details by session name
minsky session pr get feat-auth

# Get PR details by task ID
minsky session pr get --task 123

# Auto-detect from current session workspace
minsky session pr get

# Include full content
minsky session pr get --content

# JSON output
minsky session pr get --json
```

## Script Migration

### Update Shell Scripts

If you have shell scripts or aliases using the old command:

**Before:**
```bash
#!/bin/bash
# OLD: This will fail
minsky session pr --title "Release $VERSION" --body-path release-notes.md
```

**After:**
```bash
#!/bin/bash
# NEW: Use explicit create subcommand
minsky session pr create --title "Release $VERSION" --body-path release-notes.md
```

### Update CI/CD Pipelines

**Before:**
```yaml
# OLD GitHub Actions/CI configuration
- name: Create PR
  run: minsky session pr --title "${{ env.PR_TITLE }}" --body "${{ env.PR_BODY }}"
```

**After:**
```yaml
# NEW GitHub Actions/CI configuration  
- name: Create PR
  run: minsky session pr create --title "${{ env.PR_TITLE }}" --body "${{ env.PR_BODY }}"
```

### Update Documentation

Update any documentation, README files, or guides that reference the old command:

- Replace `minsky session pr` with `minsky session pr create`
- Add examples of new `list` and `get` subcommands
- Update help text and usage examples

## Error Messages

### Old Command Errors

If you try to use the old command, you'll see:

```bash
$ minsky session pr --title "test"
error: unknown option '--title'
```

This indicates you need to use `minsky session pr create` instead.

### Missing Subcommand

If you run `minsky session pr` without a subcommand:

```bash
$ minsky session pr
Usage: minsky session pr [options] [command]

pr commands

Commands:
  create [options]  Create a pull request for a session
  list [options]    List all pull requests associated with sessions  
  get [options]     Get detailed information about a session pull request
```

## Backwards Compatibility

### What's Preserved

1. **All Parameters**: The `create` subcommand supports all the same parameters as the old `session pr` command
2. **Behavior**: `session pr create` behaves identically to the old `session pr` command
3. **Auto-detection**: Session context auto-detection still works the same way
4. **Error Handling**: Same error messages and validation logic

### What's New

1. **Explicit Subcommands**: More consistent with modern CLI patterns
2. **List Functionality**: Ability to see all session PRs at once
3. **Get Functionality**: Detailed PR information and content
4. **Better Organization**: Clearer command structure for future features

## Quick Reference

| Old Command | New Command | Notes |
|-------------|-------------|-------|
| `minsky session pr --title "..." --body "..."` | `minsky session pr create --title "..." --body "..."` | Exact same functionality |
| N/A | `minsky session pr list` | New: List all session PRs |
| N/A | `minsky session pr get [name]` | New: Get detailed PR info |

## Future Enhancements

The new subcommand structure enables future enhancements:

- `minsky session pr edit` - Modify PR title/description
- `minsky session pr status` - Update PR status or labels  
- `minsky session pr merge` - Merge PR with proper checks
- `minsky session pr close` - Close PR without merging

## Getting Help

- Use `minsky session pr --help` to see available subcommands
- Use `minsky session pr create --help` for create-specific options
- Use `minsky session pr list --help` for list-specific options
- Use `minsky session pr get --help` for get-specific options

## Support

If you encounter issues during migration:

1. Check that you're using `create` subcommand for PR creation
2. Verify all parameters are spelled correctly
3. Run with `--debug` flag for detailed error information
4. Check `minsky session list` to see available sessions

The new subcommand structure provides the same functionality with better organization and new capabilities for managing session PRs. 
