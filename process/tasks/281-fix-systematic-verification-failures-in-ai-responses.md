# Task #281: Fix Systematic Verification Failures in AI Responses

## Problem Statement

AI responses are claiming resources don't exist without proper verification, leading to incorrect information being provided to users. This was demonstrated when the AI claimed the `self-improvement.mdc` rule didn't exist when it clearly does exist in the workspace.

## Root Cause Analysis

**Error Category: Verification Error**
- Failed to use proper search tools before making negative claims
- Relied on incomplete rule fetching instead of comprehensive file search
- Did not follow existing verification protocols

## Requirements

1. **Mandatory Verification Protocol**: Before claiming any resource doesn't exist, must:
   - Use file_search tool to look for the resource
   - Use grep_search if needed for content verification
   - Only claim non-existence after exhaustive search

2. **Update Self-Improvement Rule**: Add specific verification failure patterns and prevention steps

3. **Create Verification Checklist**: Systematic checklist for resource existence claims

4. **Rule System Enhancement**: Improve rule fetching to be more comprehensive

## Acceptance Criteria

- [ ] All negative existence claims must be backed by proper tool usage
- [ ] Self-improvement rule updated with verification failure patterns
- [ ] Verification checklist created and integrated
- [ ] Test case created to prevent regression

## Implementation Notes

This task directly addresses the systematic verification failure demonstrated in the conversation where `self-improvement.mdc` was incorrectly claimed to not exist.

## Immediate Actions Required

1. Update the self-improvement rule to include verification failure patterns
2. Create mandatory verification protocol before negative claims
3. Add enforcement mechanisms to prevent recurrence

## Context

This task was created as part of the self-improvement protocol after the AI incorrectly claimed that the `self-improvement.mdc` rule didn't exist when asked about it by the user.
