# Fix indentation linter errors in session.ts

## Status

BACKLOG

## Priority

MEDIUM

## Description

Fix ESLint indentation errors in src/domain/session.ts preventing commits:

## Problem
7 indentation errors in src/domain/session.ts (lines 596-602):
- Expected indentation of 10 spaces but found 12 (lines 596-601)  
- Expected indentation of 8 spaces but found 10 (line 602)

## Solution
- Fix indentation to match ESLint rules
- Ensure code follows consistent indentation patterns
- Verify fix resolves all linter errors

## Impact
These errors are blocking git commits due to pre-commit hooks.

## Requirements

[To be filled in]

## Success Criteria

[To be filled in]
