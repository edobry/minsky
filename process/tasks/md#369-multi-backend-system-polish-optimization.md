# Multi-Backend System Polish & Optimization

## Context

TECHNICAL DEBT CLEANUP & UX IMPROVEMENTS

Consolidate remaining inconsistencies and improve UX for the multi-backend task system.

## 🔧 Backend Consolidation Audit

**Problem**: Multiple task backend files may still have inconsistencies

- **Files to audit**: `markdownTaskBackend.ts`, `markdown-task-backend.ts`, etc.
- **Goal**: Ensure ALL task operations use unified TaskId system consistently
- **Check**: Task creation, parsing, formatting, validation across all backends
- **Outcome**: Single source of truth for task ID handling

## 🎯 Enhanced Error Messages

**Problem**: Error messages still reference old validation patterns

- **Current**: `"Task ID must be a valid number (with or without # prefix, e.g., '283', '#283', 'task#283')"`
- **Better**: `"Task ID must be qualified (md#123, gh#456) or legacy format (123, #123)"`
- **Files**: `src/schemas/common.ts`, error templates, CLI help text
- **Impact**: Better user guidance for multi-backend workflows

## 🚀 Migration Command for Legacy Tasks

**Problem**: Users with legacy task IDs need migration path

- **Command**: `minsky tasks migrate --from-legacy --to-backend md`
- **Function**: Convert all #123 → md#123 in tasks.md
- **Features**:
  - Dry-run mode: `--dry-run` to preview changes
  - Backup creation: Automatic backup before migration
  - Selective migration: `--filter status=TODO` to migrate specific tasks
  - Progress reporting: Show migration progress and results
- **Safety**: Validation and rollback capability

## �� Performance Optimization

**Problem**: Current implementation uses inefficient `require()` calls

- **Issue**: `const { isQualifiedTaskId } = require("./unified-task-id");` inside functions
- **Solution**: Convert to static imports for better performance
- **Files**: `taskConstants.ts`, `taskFunctions.ts`, `task-id-utils.ts`
- **Benefit**: Faster execution, cleaner code, better tree-shaking

## Success Criteria

- ✅ All backends use unified TaskId system consistently
- ✅ Clear, helpful error messages for qualified IDs
- ✅ Working migration command with safety features
- ✅ Performance optimized imports (no runtime require() calls)
- ✅ Comprehensive testing of all changes

## Priority

Medium - Polish work that improves UX and performance after core functionality is complete.

## Requirements

## Solution

## Notes
