# Extend type composition refactoring to other MCP command domains

## Context

Investigate and apply type composition patterns beyond session commands to eliminate argument duplication across all MCP tool domains.

## Background

Task #322 successfully implemented type composition for session-related MCP tools (session-workspace.ts, session-files.ts, session-edit-tools.ts), creating:
- Composable Zod schemas in common-parameters.ts
- Standardized response builders in common-responses.ts  
- Common error handling patterns

## Investigation Scope

Analyze other command domains for similar refactoring opportunities:

### 1. Direct MCP Command Implementations
- Check if any other files in src/adapters/mcp/ implement direct command handlers
- Look for manual response construction patterns
- Identify argument duplication across related commands

### 2. Bridge Pattern Analysis  
- Evaluate shared-command-integration.ts for optimization opportunities
- Check if the bridge pattern could benefit from type composition
- Analyze parameter conversion and validation layers

### 3. Domain-Specific Opportunities
- Git operations (if any direct implementations exist)
- Task management commands
- Rules management commands  
- Configuration commands
- Debug/utility commands

## Expected Deliverables

1. **Comprehensive audit** of all MCP command implementations
2. **Identification of refactoring opportunities** with priority ranking
3. **Architecture recommendations** for extending type composition patterns
4. **Implementation plan** for applying similar refactoring where beneficial

## Success Criteria

- [ ] All MCP command domains analyzed for type composition opportunities
- [ ] Clear recommendations for extending the refactoring patterns
- [ ] Documented architecture for cross-domain type sharing
- [ ] Implementation roadmap with effort estimates

## Requirements

## Solution

## Notes
