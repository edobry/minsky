# Fix session pr path resolution issues

## Status

CONSOLIDATED → See Task #214

## Priority

MEDIUM

## Description

**This task has been consolidated into Task #214: "Investigate and Fix normalizeRepoName function and repo name formatting inconsistencies"**

Session pr command tries to access wrong directory path (without local- prefix). The command looks for /Users/user/.local/state/minsky/git/minsky/sessions/task#X but actual path is /Users/user/.local/state/minsky/git/local-minsky/sessions/task#X. This causes git operations to fail.

## Consolidation Notes

This issue was identified as being related to broader repo name formatting inconsistencies in the `normalizeRepoName` function. Rather than fixing this specific symptom in isolation, it has been consolidated with the investigation task to ensure we address the root cause.

**See Task #214 for the complete investigation and fix implementation plan.**

## Requirements

**MOVED TO TASK #214**

## Success Criteria

**MOVED TO TASK #214**
