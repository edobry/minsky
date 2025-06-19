# Fix minsky rules CLI to operate on rules in the current workspace (main or session)

## Description

Currently, minsky rules commands (list, get, update, etc.) only operate on the main workspace's .cursor/rules directory, even when run from a session workspace. This causes confusion and prevents session-based rule editing and verification.

Update the minsky rules CLI to always operate on the .cursor/rules directory in the current working directory, whether in the main workspace or a session workspace.

## Context

The Minsky rules system currently only works with the main workspace's rules directory, even when executed from a session workspace. This behavior is confusing to users who expect commands to operate on the context they're currently in. It also prevents proper session-based rule development and testing workflows, as users need to switch back to the main workspace to manage rules.

## Acceptance Criteria

- All minsky rules commands (list, get, update, create, etc.) operate on the rules in the current workspace.
- Behavior is consistent and predictable in both main and session workspaces.
- Add tests to verify correct behavior in both contexts.
- Update documentation to clarify this behavior.

## Tags

cli, rules, bug, session
