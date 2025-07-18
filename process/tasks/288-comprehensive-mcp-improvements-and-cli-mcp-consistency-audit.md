# Comprehensive MCP Improvements and CLI/MCP Consistency Audit

## Status

BACKLOG

## Priority

MEDIUM

## Description

## Objectives

1. **Improve MCP Error Handling**
   - Standardize error response format across all MCP tools
   - Enhance error messages with better context and actionability
   - Prevent stack trace leaks in production MCP responses
   - Add field-specific validation error messages

2. **Document MCP Architecture**
   - Document shared command integration bridge mechanics
   - Explain parameter filtering and schema conversion process
   - Create guide for adding new commands with MCP support
   - Document MCP vs CLI behavioral differences

3. **Investigate CLI/MCP Consistency**
   - Audit Task #097 implementation for centralized descriptions
   - Verify shared command integration uses option-descriptions.ts
   - Compare CLI help text vs MCP tool descriptions for consistency
   - Remediate any inconsistencies found
   - Add regression tests to prevent future divergence

## Context

Recent investigation into MCP tool registration issues revealed several areas needing improvement:
- Error handling lacks standardization and context
- Architecture documentation is incomplete
- CLI/MCP consistency may have gaps despite Task #097

This follows up on the work completed in fixing MCP tool registration issues (removed "(MCP optimized)" suffixes, underscore aliases, and redundant JSON parameters).

## Requirements

### Phase 1: MCP Error Handling Improvements

1. **Standardize Error Response Format**
   - Create consistent error response schema for all MCP tools
   - Include error codes, messages, and contextual information
   - Ensure errors are properly typed and serializable

2. **Enhanced Error Messages**
   - Add specific context about what operation failed
   - Include suggestions for resolution where possible
   - Provide clear distinction between user errors vs system errors

3. **Security Considerations**
   - Prevent stack traces from leaking in production
   - Sanitize error messages to avoid exposing internal paths
   - Log detailed errors server-side while showing safe messages to clients

4. **Field-Specific Validation**
   - Return specific validation errors for individual parameters
   - Map Zod validation errors to user-friendly messages
   - Include which specific field caused validation failure

### Phase 2: MCP Architecture Documentation

1. **Bridge Mechanics Documentation**
   - Document how shared commands work in MCP context
   - Explain parameter transformation and filtering
   - Detail schema conversion from command definitions to MCP tools

2. **Developer Guide**
   - Step-by-step guide for adding new MCP-enabled commands
   - Best practices for parameter design
   - Testing strategies for MCP tools

3. **Behavioral Differences**
   - Document when CLI and MCP behavior intentionally differs
   - Explain JSON handling differences
   - Cover error handling variations between interfaces

### Phase 3: CLI/MCP Consistency Audit

1. **Task #097 Implementation Review**
   - Verify option-descriptions.ts is properly used
   - Check if shared command integration leverages centralized descriptions
   - Identify any gaps in the original implementation

2. **Consistency Verification**
   - Compare CLI help output with MCP tool descriptions
   - Verify parameter names and types match between interfaces
   - Check that required/optional parameter handling is consistent

3. **Remediation**
   - Fix any inconsistencies found during audit
   - Update shared command integration if needed
   - Ensure centralized descriptions are properly utilized

4. **Regression Prevention**
   - Add tests that verify CLI/MCP consistency
   - Create validation scripts that can be run during CI
   - Document the consistency requirements

## Implementation Steps

### Phase 1: Error Handling (Priority: High)

1. [ ] Create standardized error response schema in schemas/
2. [ ] Update shared-command-integration.ts to use standardized errors
3. [ ] Implement error sanitization for production use
4. [ ] Add field-specific validation error mapping
5. [ ] Update all MCP adapters to use new error handling
6. [ ] Add error handling tests

### Phase 2: Documentation (Priority: High)

1. [ ] Create docs/mcp-architecture.md with bridge mechanics
2. [ ] Write developer guide for adding MCP commands
3. [ ] Document behavioral differences between CLI and MCP
4. [ ] Add code examples and best practices
5. [ ] Review and update existing MCP-related documentation

### Phase 3: Consistency Audit (Priority: Medium)

1. [ ] Audit Task #097 implementation completeness
2. [ ] Create comparison script for CLI vs MCP descriptions
3. [ ] Run comprehensive consistency check
4. [ ] Fix any inconsistencies found
5. [ ] Add regression tests for consistency
6. [ ] Document consistency requirements

## Verification

- [ ] All MCP tools return standardized error responses
- [ ] Error messages provide clear context and actionable information
- [ ] No stack traces leak in production MCP responses
- [ ] Field-specific validation errors are properly returned
- [ ] Architecture documentation is complete and accurate
- [ ] Developer guide enables adding new MCP commands
- [ ] CLI and MCP descriptions are consistent across all commands
- [ ] Task #097 implementation gaps are addressed
- [ ] Regression tests prevent future consistency issues

## Success Criteria

1. **Error Handling**: Robust, secure, and user-friendly error responses
2. **Documentation**: Complete architectural understanding and developer guidance
3. **Consistency**: Perfect alignment between CLI and MCP interfaces
4. **Maintainability**: Clear processes for maintaining consistency going forward


## Requirements

[To be filled in]

## Success Criteria

[To be filled in]
