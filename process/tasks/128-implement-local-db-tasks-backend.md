# Task #128: Implement Local DB Tasks Backend
## Context

The current Minsky CLI uses a file-based approach (`tasks.md`) as its default task management backend, with a placeholder for a GitHub backend. This approach creates synchronization challenges when working across multiple sessions or workspaces. Specifically:
1. When a user edits the `tasks.md` file in a session, those changes are not reflected in other sessions or in the main workspace
2. This can lead to out-of-date task information when working in different contexts
3. Sometimes conflicting task IDs can occur due to this lack of synchronization
We need a more robust backend similar to the SessionDB, which already uses a local JSON file stored in a centralized location.

## Requirements

1. TBD

## Implementation Steps

1. [ ] TBD

## Verification

- [ ] TBD
