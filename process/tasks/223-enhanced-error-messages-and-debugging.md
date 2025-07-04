# Enhanced Error Messages and Debugging

## Status

IN-PROGRESS (Templates Complete, Integration Remaining)

## Priority

MEDIUM

## Description

Improve error messages based on specific failures encountered in Task 209: 1) 'Cannot run session pr from PR branch' should suggest switching to session branch, 2) Task ID parsing errors should show supported formats (numeric vs alphanumeric), 3) Variable naming errors should point to specific declaration vs usage mismatches, 4) Git command hanging should timeout with helpful messages, 5) Merge conflict errors should identify specific conflicting files and suggest resolution strategies, 6) Backend detection failures should show available backends and configuration requirements.

## Dependencies and Context

**High overlap with Task 169 (Error Message Deduplication):**

- Task 169 provides the error template infrastructure this task needs
- Task 169's template system includes `ErrorEmojis`, `buildErrorMessage`, and specialized error templates
- Task 169 created 9 template functions for common error patterns
- **COMPLETED**: Using Task 169's template system for all error message enhancements

**Complementary scope:**

- Task 169: Infrastructure and systematic deduplication across codebase
- Task 223: Specific error scenarios and user experience improvements from Task 209

## Progress Summary

### ✅ Completed (Templates & Infrastructure)

- Created comprehensive enhanced error templates (`enhanced-error-templates.ts`)
- Built git execution utility with timeout handling (`git-exec-enhanced.ts`)
- Added extensive test coverage (18/18 tests passing)
- Integrated session PR branch error enhancement
- Integrated task ID parsing error enhancement

### 🔄 Remaining (Integration Work)

- Variable naming error integration (find validation points)
- Git command timeout integration (replace ~50+ execAsync calls)
- Merge conflict handling integration (replace git merge operations)
- Backend detection error integration (apply to detector/config services)

## Requirements

1. **✅ Session PR Branch Error**: Detect when user attempts `session pr` from PR branch and suggest switching to session branch

   - **COMPLETED**: Enhanced template integrated in `session.ts`

2. **✅ Task ID Parsing**: Show supported formats (numeric vs alphanumeric) when parsing fails

   - **COMPLETED**: Enhanced template integrated in `taskCommands.ts`

3. **🔄 Variable Naming**: Point to specific declaration vs usage mismatches in error messages

   - **Template Ready**: `createVariableNamingErrorMessage` created
   - **Integration Needed**: Find variable validation points and apply template

4. **🔄 Git Command Timeouts**: Add timeout handling with helpful messages for hanging git commands

   - **Utility Ready**: `git-exec-enhanced.ts` with timeout handling created
   - **Integration Needed**: Replace ~50+ `execAsync` calls in git operations

5. **🔄 Merge Conflict Details**: Identify specific conflicting files and suggest resolution strategies

   - **Utility Ready**: Conflict detection built into `git-exec-enhanced.ts`
   - **Integration Needed**: Replace git merge operations with enhanced handling

6. **🔄 Backend Detection**: Show available backends and configuration requirements when detection fails
   - **Template Ready**: `createBackendDetectionErrorMessage` created
   - **Integration Needed**: Apply to `backend-detector.ts` and `configuration-service.ts`

## Success Criteria

1. ✅ All 6 error scenarios from Task 209 have improved, actionable error messages
2. ✅ Error messages use Task 169's template system for consistency
3. ✅ Error messages include specific context and suggested actions
4. 🔄 Timeout handling prevents hanging git operations
5. ✅ Users can quickly understand and resolve common errors
6. ✅ Error message improvements are covered by tests

## Remaining Integration Tasks

### Priority 1: Backend Detection (Highest User Impact)

- **Files**: `src/domain/configuration/backend-detector.ts`, `configuration-service.ts`
- **Effort**: ~2 hours
- **Impact**: Improves configuration/setup experience

### Priority 2: Git Command Timeouts (Most Operations)

- **Files**: `src/domain/git.ts`, `conflict-detection.ts`, `workspace/special-workspace-manager.ts`
- **Effort**: ~4 hours
- **Impact**: Prevents hanging operations, better error context

### Priority 3: Variable Naming (Development Experience)

- **Files**: Find variable validation points (ESLint rules, TypeScript errors)
- **Effort**: ~2 hours
- **Impact**: Better developer debugging experience

### Priority 4: Merge Conflict Enhancement (Advanced Git)

- **Files**: Git merge operations throughout codebase
- **Effort**: ~3 hours
- **Impact**: Better conflict resolution guidance
