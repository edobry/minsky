# Add session repair command and --draft mode to session pr create

## Context

This task implements:

1. Session repair command for fixing corrupted PR state
   - Detects incorrect pr/ branch format for GitHub backend  
   - Clears stale PR state with non-existent branches
   - Backend type synchronization validation
   - Multiple repair modes: --dry-run, --auto, --pr-state, --backend-sync

2. Draft PR functionality for session pr create
   - --draft flag that works only with GitHub repository backend
   - Creates draft pull requests correctly
   - Does not perform session update when creating draft PRs
   - Properly tracks draft state in session records

Both features are fully implemented and tested.

## Requirements

## Solution

## Notes
