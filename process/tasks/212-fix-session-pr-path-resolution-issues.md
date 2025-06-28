# Fix session pr path resolution issues

## Status

BACKLOG

## Priority

MEDIUM

## Description

Session pr command tries to access wrong directory path (without local- prefix). The command looks for /Users/user/.local/state/minsky/git/minsky/sessions/task#X but actual path is /Users/user/.local/state/minsky/git/local-minsky/sessions/task#X. This causes git operations to fail.

## Requirements

[To be filled in]

## Success Criteria

[To be filled in]
