# Task #149: Investigate and Restore Missing Init Command Interactivity

## Context

The `minsky init` command previously had interactive prompts for backend selection, GitHub configuration, and other options, but this functionality appears to have been lost during refactoring. Users expect interactive prompts when required parameters are not provided, similar to other Minsky commands.

## Problem Statement

The init command currently:
- Uses silent defaults when parameters are not provided
- Does not prompt for backend selection
- Does not prompt for GitHub owner/repo when github-issues backend is used
- Lacks the interactive experience that other Minsky commands provide

## Requirements

### Investigation Phase
- [ ] Search git history to identify when interactive prompts were removed
- [ ] Identify the cause of removal (refactoring, migration to shared commands, etc.)
- [ ] Locate the original interactive implementation code
- [ ] Document what changed and why

### Restoration Phase
- [ ] Add interactive prompts for backend selection when `--backend` not provided
- [ ] Add GitHub owner/repo prompts when `github-issues` backend is selected
- [ ] Add rule format preference prompt when `--rule-format` not provided
- [ ] Add MCP configuration prompts when not specified
- [ ] Follow existing patterns from `tasks status set` command
- [ ] Use `@clack/prompts` for consistency with other commands
- [ ] Maintain backward compatibility with explicit flags

### Interactive Flow Design
1. **Backend Selection**: When no `--backend` flag provided, prompt with options:
   - `json-file` (recommended for new projects)
   - `markdown` (for existing tasks.md workflows)
   - `github-issues` (for GitHub integration)

2. **GitHub Configuration**: When `github-issues` selected, prompt for:
   - GitHub repository owner
   - GitHub repository name

3. **Rule Format**: When no `--rule-format` provided, prompt for:
   - `cursor` (default)
   - `generic` (for non-Cursor editors)

4. **MCP Configuration**: Prompt for MCP settings:
   - Enable/disable MCP
   - Transport type (if enabled)

## Technical Implementation

### Code Locations to Update
- `src/adapters/shared/commands/init.ts` - Add interactive prompts
- `src/domain/init.ts` - Update to handle interactive parameters
- Follow patterns from `src/adapters/shared/commands/tasks.ts` (status set command)

### Dependencies
- Ensure `@clack/prompts` is available and working
- Test interactive prompts in different terminal environments

## Acceptance Criteria

- [ ] Running `minsky init init` without parameters prompts for all options
- [ ] Explicit flags still override prompts (backward compatibility maintained)
- [ ] Interactive experience matches other Minsky commands in style and UX
- [ ] All backend types supported with appropriate follow-up prompts
- [ ] GitHub backend prompts for owner/repo details
- [ ] Rule format selection works correctly
- [ ] MCP configuration prompts work
- [ ] Non-interactive mode still works when all flags provided
- [ ] Prompts handle cancellation gracefully
- [ ] Generated configuration files are correct based on selections

## Testing Strategy

- [ ] Test interactive flow with all backend combinations
- [ ] Test explicit flag override behavior
- [ ] Test cancellation handling
- [ ] Test in different terminal environments
- [ ] Verify generated files match selections
- [ ] Test backward compatibility with existing scripts

## Notes

This task aims to restore user-friendly interactive initialization while maintaining all existing functionality and backward compatibility. 
