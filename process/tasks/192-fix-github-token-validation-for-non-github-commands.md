# Fix GitHub Token Validation for Non-GitHub Commands

## Summary
Commands that don't require GitHub access (like task status, list with non-GitHub backends) should not fail or show warnings when GitHub tokens are missing. Currently all commands show GitHub token warnings even when using local backends.

## Problem
- `minsky tasks status` shows GitHub token warnings for json-file backend
- `minsky tasks list` shows GitHub token warnings even with local backends
- Commands should only validate GitHub tokens when actually needed

## Solution
- Move GitHub token validation to only happen when GitHub backend is used
- Implement lazy credential loading in credential manager
- Only show token warnings for commands that actually need GitHub access

## Acceptance Criteria
- `minsky tasks list` with json-file backend: no GitHub warnings
- `minsky tasks status` with local backend: no GitHub warnings  
- `minsky tasks list --backend github-issues`: show GitHub warnings if token missing
- Commands only validate credentials for the backend they're actually using
