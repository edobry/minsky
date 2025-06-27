# Task 169: Evaluate and Deduplicate Improved Error Messages

## Overview

Evaluate the recently improved error messages across the codebase to identify duplication and extract common sections into reusable components.

## Background

Recent improvements to error messages in session PR workflows and other areas have introduced more detailed, actionable guidance for users. However, there may be opportunities to:

1. Extract common error message patterns
2. Create reusable error message templates
3. Ensure consistency across different error scenarios
4. Reduce code duplication

## Tasks

### 1. Audit Current Error Messages

- [x] Scan codebase for error message patterns
- [x] Identify similar error message structures
- [x] Document current error message locations and content
- [x] Look for duplication in conflict resolution guidance
- [x] Check for consistency in formatting and tone
  - **Completed**: Found 40+ instances of repeated `error instanceof Error ? error.message : String(error)` pattern
  - **Completed**: Identified verbose multi-line error messages with inconsistent formatting
  - **Completed**: Created comprehensive analysis documentation

### 2. Identify Common Patterns

- [x] Extract common error message components:
  - Step-by-step instructions
  - Alternative approaches
  - Tips and best practices
  - Command examples
  - Context-aware messaging
- [x] Identify reusable message templates
- [x] Document error message taxonomy
  - **Completed**: Identified 9 core error patterns (session, git, validation, resource not found, etc.)
  - **Completed**: Created template functions for each pattern

### 3. Design Error Message System

- [x] Create error message template system
- [x] Design composable error message components
- [x] Ensure consistent formatting and emojis
- [x] Support context-aware message customization
- [x] Maintain backward compatibility
  - **Completed**: Built comprehensive template system with ErrorEmojis, ErrorContextBuilder, and specialized templates
  - **Completed**: Created SessionErrorType enum to replace confusing string literals
  - **Completed**: Added convenience functions for common patterns

### 4. Implementation

- [x] Extract common error message utilities
- [x] Create reusable error message templates
- [x] Add tests for error message generation
- [x] Update documentation
- [ ] Refactor existing error messages to use templates (PARTIAL - 1 of 40+ completed)

### 5. Validation

- [x] Verify all error scenarios still work correctly
- [x] Ensure message consistency across interfaces
- [x] Test context-aware message generation
- [ ] Validate user experience improvements (IN PROGRESS - need to refactor more messages)
  - **Completed**: 31/31 tests passing for template system
  - **Completed**: Demonstrated 80% code reduction (16 lines → 2 lines)
  - **Completed**: All template functions tested and validated

## Success Criteria

- [x] Reduced duplication in error message code (80% reduction demonstrated)
- [x] Consistent error message formatting and tone (ErrorEmojis system implemented)
- [x] Reusable error message components (9 template functions created)
- [x] Improved maintainability of error messages (template system with tests)
- [ ] No regression in user experience (PARTIAL - need more refactoring)

## Current Status

**INFRASTRUCTURE COMPLETE** - Template system fully implemented and tested
**REFACTORING IN PROGRESS** - Applied to 1 of 40+ identified error patterns

### Next Steps

- Continue refactoring remaining 39+ error message patterns
- Apply templates to verbose session errors in session.ts
- Replace repeated `error instanceof Error ? error.message : String(error)` patterns
- Validate improvements in real usage scenarios

## Priority

Medium

## Estimated Effort

3-5 hours
