# Audit codebase for git command timeout issues and create ESLint rule

## Status

BACKLOG

## Priority

MEDIUM

## Description

Conduct a comprehensive audit of the codebase to identify all instances where `execAsync` is used for git operations without proper timeout handling. Create or enhance ESLint rules to enforce the use of timeout-aware git utilities like `execGitWithTimeout`.

## Background
During task #280, we discovered that `execAsync` calls without timeouts in git operations (like in `prepare-pr-operations.ts`) can cause commands to hang indefinitely, leading to poor user experience and debugging difficulties.

## Scope
1. **Audit Phase**:
   - Search for all `execAsync` usage in git-related files
   - Identify patterns where git commands lack timeout protection
   - Document findings with risk assessment (network ops = high risk, local ops = medium risk)

2. **Rule Enhancement**:
   - Extend the existing `no-unsafe-git-exec.js` ESLint rule if needed
   - Ensure rule covers all git operation patterns
   - Add auto-fix suggestions where possible

3. **Remediation**:
   - Replace unsafe `execAsync` calls with `execGitWithTimeout`
   - Add timeout context for better debugging
   - Test that changes don't break existing functionality

## Priority
High - This prevents the type of hanging issues that blocked task #280 session PR creation

## Success Criteria
- [ ] Complete audit report with all unsafe git exec patterns identified
- [ ] Enhanced ESLint rule that catches all problematic patterns
- [ ] All identified unsafe patterns fixed
- [ ] No regressions in existing git functionality

## Requirements

[To be filled in]

## Success Criteria

[To be filled in]
