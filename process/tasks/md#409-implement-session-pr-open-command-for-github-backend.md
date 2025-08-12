# md#409: Implement session pr open command for GitHub backend

## Context

Add a `session pr open` subcommand that opens the pull request in the default web browser.

## Overview

Implement a convenience command to quickly jump from the CLI to the GitHub web interface for viewing/editing a session's pull request.

## Requirements

- Add `session pr open` subcommand to the existing session PR command structure
- Only works with GitHub repository backend (error for local/remote backends)
- Opens the PR URL in the user's default web browser
- Auto-detect current session when run from session workspace
- Support explicit session specification with `--session` parameter
- Handle cases where no PR exists for the session with clear error message

## Implementation

- Add `SessionPrOpenCommand` class following existing patterns
- Add `sessionPrOpen` function in pr-subcommands.ts
- Use the existing GitHub backend integration to get PR URL
- Use system's default browser opener (likely via `open` command or similar)
- Follow same error handling patterns as other session pr commands

## Behavior

```bash
# From session workspace
minsky session pr open

# Explicit session
minsky session pr open --session task-123

# Error cases
minsky session pr open  # No PR exists -> clear error
minsky session pr open  # Local backend -> unsupported operation error
```

This provides a streamlined workflow for developers to quickly view their PRs without manually navigating to GitHub.

## Requirements

## Solution

## Notes
