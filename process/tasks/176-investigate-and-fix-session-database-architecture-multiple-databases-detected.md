# Task 176: Investigate and fix session database architecture - multiple databases detected

**Status:** TODO
**Priority:** HIGH
**Assignee:** edobry
**Created:** 2025-01-28

## Problem

During investigation of session PR command issues in Task #165, discovered that the session database architecture is fundamentally flawed:

**CRITICAL ISSUE**: Multiple session databases exist instead of one system-wide database

- Session workspaces appear to have their own .minsky/config.yaml
- Different Minsky invocations may be using different database instances
- This violates the core principle that there should be ONE session database system-wide

## Root Cause Analysis Needed

1. **Database Location Investigation**

   - Where is the session database supposed to be stored?
   - What is the intended single source of truth for session records?
   - Why are there multiple .minsky/config.yaml files?

2. **Configuration Architecture Review**

   - How should workspace vs global configuration work?
   - What should session workspaces inherit vs configure independently?
   - When is it appropriate to have different database configurations?

3. **Session Detection Logic**
   - How should session detection work from different working directories?
   - Should createSessionProvider() take workingDir parameter at all?
   - What's the correct way to detect current session context?

## Current Problematic Behavior

- createSessionProvider({ workingDir: currentDir }) suggests multiple databases
- Session workspaces have .minsky/config.yaml that may point to different databases
- GitService and sessionPrFromParams were using different database instances
- 'Session not found' errors when session clearly exists (database inconsistency)

## Expected Correct Behavior

- ONE system-wide session database for all Minsky operations
- Session detection should work from any working directory
- All session commands should see the same session records
- Configuration should be hierarchical: global settings + workspace overrides (not database location)

## Investigation Tasks

- [ ] Map all locations where session databases are created/accessed
- [ ] Identify the intended single database location
- [ ] Review createSessionProvider() and SessionDB architecture
- [ ] Understand why workspace configuration exists and what it should contain
- [ ] Design proper session detection that doesn't require multiple databases
- [ ] Create migration plan to consolidate to single database if needed

## Success Criteria

- Only ONE session database exists system-wide
- Session commands work from any directory without database confusion
- Clear documentation of session database architecture
- Proper session detection without workspace-specific database instances

## Priority: HIGH

This is a fundamental architectural issue that affects session reliability.

## Related Tasks

- Task #165: Revealed this issue during session PR command investigation
- Task #168: May be related to session lookup bugs

## Technical Notes

The current "fix" in Task #165 using `createSessionProvider({ workingDir: currentDir })` is a **workaround** that masks the real problem. The architecture needs to be redesigned to use a single database while still supporting proper session detection from different working directories.

## Impact

This issue affects:

- Session PR commands
- Session detection reliability
- Database consistency
- Overall session management workflow
