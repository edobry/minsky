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

### 🔍 **Comprehensive Audit of MCP Command Implementations**

**Analysis completed**: All 11 MCP adapter files in `src/adapters/mcp/` analyzed for type composition opportunities.

#### **HIGH PRIORITY: Direct Implementation Files**

**1. `tasks.ts` (64 lines) - IMMEDIATE REFACTORING TARGET**
- ❌ **Issue**: Temporary direct implementation bypassing shared command integration
- ❌ **Root Cause**: "Async hanging issues" with shared command bridge
- ❌ **Current State**: Placeholder handlers returning "temporarily disabled" messages
- ❌ **Pattern Violations**: Manual `success: true` responses, no standardized response builders
- **Impact**: 2 commands (`tasks.create`, `tasks.list`) completely non-functional via MCP

**2. `session.ts` (51 lines) - SECONDARY TARGET**
- ❌ **Issue**: Completely disabled due to "import issues"
- ❌ **Root Cause**: Session workspace schema problems
- ❌ **Current State**: All bridge integration code commented out
- **Impact**: 8 session commands unavailable via MCP (forcing CLI-only usage)

#### **BRIDGE PATTERN SUCCESS STORIES**

**Successfully Using Type Composition via Bridge:**
- ✅ `rules.ts` (38 lines) - Clean bridge integration, 5 commands
- ✅ `debug.ts` (33 lines) - Clean bridge integration, 3 commands
- ✅ `git.ts` (50 lines) - Bridge integration (commands hidden by design)
- ✅ `init.ts` (26 lines) - Clean bridge integration, 1 command

#### **ALREADY REFACTORED SESSION TOOLS**

**Type Composition Success:**
- ✅ `session-workspace.ts` (655 lines) - **Task #322 SUCCESS**: Uses standardized response builders
- ✅ `session-files.ts` (420 lines) - **Task #322 SUCCESS**: Uses type composition patterns
- ✅ `session-edit-tools.ts` (294 lines) - **Task #322 SUCCESS**: Standardized error handling

### 🏗️ **Architecture Recommendations**

#### **Pattern 1: Direct Type Composition (For tasks.ts)**

**Recommended Approach**: Convert `tasks.ts` to use the same type composition patterns as session tools:

```typescript
// NEW: src/adapters/mcp/schemas/task-parameters.ts
export const TaskIdSchema = z.string().min(1);
export const TaskTitleSchema = z.string().min(1);
export const TaskStatusSchema = z.enum(['TODO', 'IN-PROGRESS', 'IN-REVIEW', 'DONE', 'BLOCKED', 'CLOSED']);

// NEW: src/adapters/mcp/schemas/task-responses.ts
export function createTaskResponse(task: any, metadata?: any) {
  return {
    success: true,
    task,
    metadata,
    interface: 'mcp'
  };
}
```

#### **Pattern 2: Bridge Pattern Enhancement (For shared-command-integration.ts)**

**Issue Diagnosis**: The "hanging issues" likely stem from:
1. **Async execution problems** in shared command handlers
2. **Circular dependency issues** with require() calls in ModularTasksCommandManager
3. **Session workspace schema validation errors**

**Recommended Fix**:
```typescript
// Enhanced error handling in shared-command-integration.ts
handler: async (args: any, projectContext?: any) => {
  try {
    const context: CommandExecutionContext = {
      interface: "mcp",
      debug: args?.debug || false,
      format: "json",
    };

    const result = await Promise.race([
      command.execute(parameters, context),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Command timeout')), 30000)
      )
    ]);

    return result;
  } catch (error) {
    return createErrorResponse(error, { command: command.id, interface: 'mcp' });
  }
}
```

#### **Pattern 3: Hybrid Approach (For session.ts)**

**Recommended**: Enable bridge pattern with session-specific schema integration:
1. **Fix import issues** by using static imports (per `@no-dynamic-imports.mdc` rule)
2. **Integrate session schemas** from Task #322 type composition work
3. **Enable bridge with session-aware error handling**

### 📋 **Implementation Roadmap with Effort Estimates**

#### **Phase 1: Tasks.ts Refactoring (2-3 hours)**
- [ ] Convert to direct type composition pattern like session tools
- [ ] Create `src/adapters/mcp/schemas/task-parameters.ts` and `task-responses.ts`
- [ ] Replace placeholder handlers with actual task operations
- [ ] Add timeout handling and error recovery

#### **Phase 2: Bridge Pattern Debugging (3-4 hours)**
- [ ] Investigate and fix "async hanging issues" in shared-command-integration.ts
- [ ] Add command timeout mechanisms
- [ ] Fix circular dependency issues in ModularTasksCommandManager
- [ ] Add comprehensive error handling and recovery

#### **Phase 3: Session.ts Re-enablement (2-3 hours)**
- [ ] Fix "import issues" with static imports
- [ ] Integrate session schemas from Task #322
- [ ] Re-enable bridge pattern with proper error handling
- [ ] Test session commands via MCP

#### **Phase 4: Cross-Domain Type Sharing (1-2 hours)**
- [ ] Extract common parameter schemas to shared location
- [ ] Create unified error response patterns
- [ ] Document type composition architecture patterns

### 🎯 **Success Criteria Status**

- [x] All MCP command domains analyzed for type composition opportunities
- [x] Clear recommendations for extending the refactoring patterns
- [x] Documented architecture for cross-domain type sharing
- [x] Implementation roadmap with effort estimates

**TOTAL ESTIMATED EFFORT**: 8-12 hours across 4 phases

**IMMEDIATE NEXT STEP**: Begin Phase 1 - Tasks.ts refactoring to prove type composition patterns work for non-session commands.

## Notes
