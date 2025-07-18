# Convert Cursor Rules to MCP-Only Tool References

## Status

BACKLOG

## Priority

MEDIUM

## Description

# Convert Cursor Rules to MCP-Only Tool References

## Context

Currently, cursor rules contain CLI command references like `minsky tasks get #123 --json` and `minsky session pr --title "..." --body-path "..."`. For MCP-only environments, these need to be converted to proper MCP tool invocations. 

**CRITICAL LESSON LEARNED**: A previous attempt (reverted in commits c5d56bbe/d2863b18) failed because it used mechanical find-and-replace without understanding that MCP tools use structured parameters, not CLI flags. This task addresses the proper approach.

## Problem Statement

### Current State
Rules reference CLI commands that don't work in MCP-only environments:
```markdown
Run `minsky tasks list --json` to query the backlog
Create PR using `minsky session pr --title "fix" --body-path "file.md"`
```

### Target State  
Rules should reference MCP tools with clear parameter guidance:
```markdown
Use MCP tool `mcp_minsky-server_tasks_list` 
Create PR using MCP tool `mcp_minsky-server_session_pr` with title and bodyPath parameters
```

## Key Requirements

### 1. **Understand MCP Tool Interfaces**
- **CRITICAL**: Analyze actual MCP tool signatures and parameters before any conversion
- Map CLI commands to their MCP tool equivalents with proper parameter names
- Understand the difference between CLI flags (`--json`) and MCP parameters (`{format: "json"}`)

### 2. **Accurate Command Mapping**
- `minsky tasks list --json` → `mcp_minsky-server_tasks_list` 
- `minsky tasks get #123` → `mcp_minsky-server_tasks_get` with `{taskId: "#123"}`
- `minsky session pr --title X --body-path Y` → `mcp_minsky-server_session_pr` with `{title: X, bodyPath: Y}`
- All other Minsky CLI commands → corresponding MCP tools

### 3. **Preserve Instructional Value**
- Don't just say "use MCP tool X" - explain what parameters are needed
- Maintain context about when and why to use each tool
- Keep examples that show the expected input/output

### 4. **Integration with Template System**
- Design conversion to be compatible with Task #289 template system
- Create reusable mappings that can be used in template conditionals
- Maintain .mdc format compatibility

## Technical Approach

### Phase 1: MCP Tool Discovery and Analysis
1. **Catalog all MCP tools** available in the minsky-server
2. **Document tool signatures** including parameter names and types  
3. **Map CLI commands to MCP tools** with parameter correspondence
4. **Identify edge cases** where CLI and MCP approaches differ significantly

### Phase 2: Conversion Strategy Development
1. **Create conversion rules** based on actual MCP tool interfaces
2. **Design template-friendly format** for conditionals (CLI vs MCP)
3. **Develop validation approach** to ensure converted rules make sense
4. **Plan rollback strategy** in case issues are discovered

### Phase 3: Rule Conversion Implementation
1. **Convert high-priority rules first** (task management, session workflows)
2. **Test converted rules** in MCP-only environment
3. **Iteratively refine** based on actual usage
4. **Document conversion patterns** for future template system

### Phase 4: Validation and Documentation
1. **Verify all converted rules** work correctly in MCP clients
2. **Create conversion documentation** for future rule authoring
3. **Update rule authoring guidelines** to prefer MCP-first approach
4. **Integrate with Task #289** template system planning

## Success Criteria

### ✅ **Functional Requirements**
- [ ] All rules work correctly in MCP-only environments
- [ ] CLI command references replaced with accurate MCP tool invocations
- [ ] Parameter guidance clear and actionable for users
- [ ] No loss of instructional value from original rules

### ✅ **Quality Requirements**  
- [ ] Converted rules tested in actual MCP client (Cursor)
- [ ] No mechanical/nonsensical conversions (learned from failed attempt)
- [ ] Maintains grammatical correctness and readability
- [ ] Examples show realistic usage patterns

### ✅ **Integration Requirements**
- [ ] Conversion mappings exported for use in Task #289 template system
- [ ] .mdc format compatibility maintained
- [ ] Rule authoring guidelines updated for MCP-first approach
- [ ] Rollback plan documented and tested

## Dependencies

- **Task #289**: Template-based rules generation system (integration point)
- **MCP server documentation**: Understanding available tools and their interfaces
- **Cursor MCP integration**: Testing environment for validation

## Risks and Mitigations

### 🚨 **Risk**: Repeat of mechanical conversion failure
**Mitigation**: Phase 1 mandatory - no conversion without understanding MCP interfaces

### 🚨 **Risk**: Loss of instructional value in rules  
**Mitigation**: Focus on maintaining context and examples, not just tool names

### 🚨 **Risk**: Breaking rules for CLI users during transition
**Mitigation**: Template system (Task #289) should support both CLI and MCP modes

### 🚨 **Risk**: Incomplete MCP tool coverage
**Mitigation**: Identify gaps early and either implement missing tools or adapt approach

## Notes

- **Previous Failed Attempt**: Commits c5d56bbe/d2863b18 demonstrate what NOT to do
- **Key Insight**: MCP tools ≠ CLI commands with different syntax; they're different interfaces
- **Integration Point**: This task prepares for Task #289 template system
- **Testing Critical**: Must validate in real MCP environment, not just syntax

## Estimated Effort

- **Phase 1 (Discovery)**: 2-3 hours to catalog and understand MCP interfaces
- **Phase 2 (Strategy)**: 1-2 hours to design conversion approach  
- **Phase 3 (Implementation)**: 4-6 hours for conversion and testing
- **Phase 4 (Validation)**: 2-3 hours for thorough testing and documentation

**Total**: 9-14 hours of focused work with proper MCP understanding 


## Requirements

[To be filled in]

## Success Criteria

[To be filled in]
