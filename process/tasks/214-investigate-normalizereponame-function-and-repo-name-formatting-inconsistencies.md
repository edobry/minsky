# Investigate normalizeRepoName function and repo name formatting inconsistencies

## Status

BACKLOG

## Priority

MEDIUM

## Description

Investigate the normalizeRepoName function and its impact on repo name formatting stored in the session database.

## Problem Statement
The normalizeRepoName function appears to be producing repo names in formats like 'local/minsky' and 'local-minsky' which may not be consistent or correct for Minsky's design and workflows.

## Investigation Areas

### 1. Function Analysis
- Examine the normalizeRepoName function implementation
- Understand its purpose and intended behavior
- Document the transformation logic and rules applied

### 2. Session Database Impact
- Analyze how normalized repo names are stored in the session database
- Identify inconsistencies in naming formats across different scenarios
- Check for potential conflicts or ambiguities in stored names

### 3. Backend Compatibility
- Investigate how normalized names interact with different repo backends:
  - Local repositories
  - GitHub repositories
  - Other potential backends
- Ensure consistent behavior across all backend types

### 4. Workflow Integration
- Examine how normalized repo names are used throughout Minsky workflows
- Check session management, task creation, and other core operations
- Identify any breaking changes or unexpected behaviors

### 5. Design Intent vs Implementation
- Determine if current behavior aligns with intended design
- Identify any gaps between expected and actual functionality
- Propose corrections if inconsistencies are found

## Deliverables
- Comprehensive analysis of normalizeRepoName function
- Documentation of current behavior vs intended behavior
- Identification of any bugs or inconsistencies
- Recommendations for fixes or improvements if needed
- Test cases to verify expected behavior

## Requirements

[To be filled in]

## Success Criteria

[To be filled in]
