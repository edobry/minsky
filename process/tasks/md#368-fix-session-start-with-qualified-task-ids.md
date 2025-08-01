# Fix Session Start with Qualified Task IDs

## Context

SESSION MANAGEMENT INTEGRATION ISSUE

## Problem Discovered
✅ Task retrieval works: `minsky tasks get "md#367"` ✅
✅ Existing sessions work: `task366 (task: md#366)` in session list ✅  
❌ Session start fails: `minsky session start --task "md#365"` → "Task md#365 not found" ❌

## Root Cause Analysis
- **Validation layer**: Fixed ✅ (no more "Task ID must be a valid number")
- **Task lookup**: Different backend/mechanism used by session start vs tasks get
- **Existing sessions**: Work fine with qualified IDs
- **New session creation**: Fails systematic lookup of qualified IDs

## Investigation Findings
- Sessions exist: `task356 (task: md#356)`, `task366 (task: md#366)`
- Session start uses different task resolution than `tasks get`
- Issue affects all qualified IDs: md#365, md#366, md#367
- Backend config correct: "Task Storage: Markdown files"

## Required Fix
1. **Identify session start task lookup path** - trace which backend/method it uses
2. **Update session task resolution** - use same unified TaskId system as tasks get
3. **Test new session creation** - verify qualified IDs work for new sessions
4. **Verify existing sessions** - ensure no regression in existing functionality

## Success Criteria
- `minsky session start --task "md#367"` works ✅
- New sessions created with qualified IDs ✅
- Existing sessions continue working ✅
- Unified backend across all task operations ✅

## Context
This completes the multi-backend task system integration. Task #367 fixed CLI validation, parsing, and task list display. This task fixes the final session management integration piece.

## Requirements

## Solution

## Notes
