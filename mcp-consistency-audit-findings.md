# MCP Consistency Audit Findings - Task #288

## Executive Summary

After comprehensive analysis following Task #322 parameter deduplication work, we have identified a **dual architecture** for MCP parameter handling that creates several consistency issues.

## Dual Architecture Overview

### System 1: Direct MCP Tools
**Files**: `session-files.ts`, `session-edit-tools.ts`, `session-workspace.ts`  
**Parameter Source**: `shared-schemas.ts`  
**Scope**: Session workspace operations (file operations, edits, searches)

### System 2: Bridged MCP Tools  
**Files**: `init.ts`, `debug.ts`, `rules.ts`, `session.ts`, `tasks.ts`, `git.ts`  
**Parameter Source**: `common-parameters.ts` → `shared-command-integration.ts`  
**Scope**: Management commands (session management, task management, git operations)

## Critical Inconsistencies Identified

### 1. JSON Parameter Inconsistency
- **Issue**: Direct MCP tools have NO `json` parameter
- **Issue**: Bridged tools have `json` parameter that gets FILTERED OUT during MCP conversion
- **Impact**: Inconsistent interface - some MCP tools appear to support JSON formatting, others don't
- **Root Cause**: `shared-command-integration.ts` line 31: `if (key === "json") { continue; }`

### 2. Session Parameter Naming Inconsistency  
- **Direct MCP tools**: Use `sessionName` parameter
- **Bridged MCP tools**: Have BOTH `session` AND `sessionName` parameters
- **Impact**: Confusing parameter names for the same concept
- **Evidence**:
  - Direct: `sessionName: z.string().describe("Session identifier (name or task ID)")`
  - Bridged: `session: { description: "Session identifier" }` AND `sessionName: { description: "Session identifier (name or task ID)" }`

### 3. Parameter Description Variations
- **Direct MCP**: `"Session identifier (name or task ID)"`  
- **Bridged MCP**: `"Session identifier"`
- **Impact**: Inconsistent help text and documentation

## Architecture Analysis

### Direct MCP Tools Architecture
```
Session Workspace Operations
└── shared-schemas.ts (409 lines)
    ├── SessionIdentifierSchema 
    ├── FilePathSchema
    ├── LineRangeSchema  
    └── 15+ composed schemas
```

### Bridged MCP Tools Architecture  
```
Management Commands
└── common-parameters.ts (382 lines)
    ├── CommonParameters.*
    ├── GitParameters.*
    ├── SessionParameters.*
    └── RulesParameters.*
        ↓
    shared-command-integration.ts
        ├── convertParametersToZodSchema()
        ├── Filter out 'json' parameter
        └── Bridge to MCP
```

## Impact Assessment

### ✅ Task #322 Success
- **MCP Parameter Deduplication**: 94% reduction in sessionName duplications (17+ → 1)
- **Shared Command Deduplication**: 70%+ reduction in parameter duplications (210+ eliminated)
- **Zero Breaking Changes**: Both systems maintained backward compatibility

### ⚠️ Architectural Inconsistencies  
- **User Confusion**: Different parameter names for same concepts
- **Documentation Gaps**: No clear explanation of dual architecture
- **Maintenance Overhead**: Two parameter systems to maintain

## Recommendations

### Phase 1: Error Handling Standardization
1. Create unified error response schema leveraging our new shared schemas
2. Ensure consistent error formatting across both architectures

### Phase 2: Parameter Naming Standardization
1. **Decision Required**: Choose `session` vs `sessionName` as standard
2. **Recommendation**: Use `sessionName` (more descriptive, matches current direct MCP usage)
3. Update shared command parameters to be consistent

### Phase 3: JSON Parameter Resolution  
1. **Option A**: Remove `json` parameter from shared commands (MCP always returns JSON)
2. **Option B**: Add `json` parameter to direct MCP tools for consistency  
3. **Recommendation**: Option A - Follow MCP's JSON-only nature

### Phase 4: Documentation
1. Document the dual architecture clearly
2. Explain when each system is used
3. Create developer guide for adding new MCP commands

## Next Steps

1. **Immediate**: Start Phase 1 - standardize error handling using existing schemas
2. **Short-term**: Resolve parameter naming inconsistencies  
3. **Medium-term**: Complete documentation and regression tests
4. **Long-term**: Consider architectural consolidation if beneficial

## Success Metrics

- [ ] Consistent error response format across all MCP tools
- [ ] Unified parameter naming conventions
- [ ] Complete architecture documentation
- [ ] Regression tests preventing future inconsistencies
- [ ] Developer guide for adding MCP commands

---

*Analysis completed as part of Task #288 following Task #322 parameter deduplication work.*