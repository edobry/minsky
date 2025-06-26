# Fix Shared Command Registry Architecture to Eliminate Interface Duplication

## Context

The shared command registry architecture is fundamentally broken, causing duplication and inconsistencies across both CLI and MCP interfaces. This architectural failure manifests in two critical ways:

1. **MCP Interface**: Completely bypasses the existing MCP bridge, manually duplicating all command definitions
2. **CLI Interface**: Requires manual parameter registration in multiple layers, breaking boolean flag handling

This creates a maintenance nightmare and defeats the purpose of the shared command registry as a single source of truth.

### Current Problems

The architecture failures manifest differently across interfaces but stem from the same root cause:

#### MCP Interface Failure
**Intended Architecture**: Shared command registry → MCP bridge → MCP server  
**Current Implementation**: Manual command duplication in MCP adapters (ignoring bridge)

#### CLI Interface Failure  
**Intended Architecture**: Shared command registry → CLI bridge → CLI commands  
**Current Implementation**: Multiple registration points with manual customizations

**Evidence of MCP Duplication:**

```typescript
// ❌ DUPLICATED: Shared command registry (src/adapters/shared/commands/tasks.ts)
const tasksCreateParams: CommandParameterMap = {
  title: { schema: z.string().min(1), description: "Title for the task", required: true },
  description: { schema: z.string(), description: "Description text", required: false },
  // ... more parameters
};

// ❌ DUPLICATED: MCP adapter (src/adapters/mcp/tasks.ts)  
z.object({
  title: z.string().optional().describe("Title for the task"),
  description: z.string().optional().describe("Description text"),
  // ... same parameters duplicated again!
})
```

**Evidence of CLI Duplication:**

```typescript
// ❌ DUPLICATED: Schema layer (src/schemas/session.ts)
export const sessionPrParamsSchema = z.object({
  noUpdate: z.boolean().optional(),
  // ... other parameters
});

// ❌ DUPLICATED: Shared command layer (src/adapters/shared/commands/session.ts)  
const sessionPrParams: CommandParameterMap = {
  noUpdate: { schema: z.boolean(), description: "Skip status update", required: false },
  // ... same parameters again
};

// ❌ DUPLICATED: CLI factory layer (src/adapters/cli/cli-command-factory.ts)
// Missing customization causes --no-update flag to not work!
```

This creates:
- **Parameter schema duplication** across all interface layers (CLI and MCP)
- **Validation logic duplication** (required/optional, descriptions)
- **Execution logic duplication** (manual parameter mapping vs bridge handling)
- **Boolean flag handling failures** (CLI flags not working due to missing registrations)
- **Manual maintenance overhead** when updating commands
- **Inconsistency risk** between CLI and MCP interfaces
- **Broken functionality** (specific example: `--no-update` flag in `session pr` command)

## Architectural Principles

### Single Source of Truth
Command definitions should exist in exactly one place (shared registry) and be automatically consumed by all interfaces. Any duplication violates this principle.

### Interface Agnostic Design  
Domain logic should be interface-independent, with bridges handling interface-specific concerns. The shared command registry provides this abstraction.

### DRY (Don't Repeat Yourself)
No command metadata, parameters, or execution logic should be duplicated across interfaces. The existing MCP bridge already provides this capability.

### Automatic Consistency
When shared commands change, all interfaces should automatically reflect those changes without manual updates. This is only possible with proper bridge integration.

## Critical Cases That Must Be Fixed

This task merges and addresses issues from multiple sources:

### From Task #172: Boolean Flag Parsing Issue
- **Specific Problem**: `--no-update` flag for `session pr` command not working
- **Root Cause**: Missing CLI factory customization for `session.pr` command
- **Broader Impact**: All boolean flags across CLI system affected by registration duplication
- **Required Fix**: Eliminate need for manual CLI factory customizations

### From Task #177: MCP Command Duplication  
- **Specific Problem**: All MCP commands manually duplicated instead of using bridge
- **Root Cause**: MCP adapters completely ignore existing MCP bridge
- **Broader Impact**: 80%+ code duplication in MCP adapter files
- **Required Fix**: Replace manual MCP registration with automatic bridge integration

### Unified Root Cause
Both issues stem from the **shared command registry architecture not working as designed**:
- CLI requires manual customizations (breaking automation)
- MCP ignores bridges entirely (breaking single source of truth)
- Both create maintenance overhead and functional bugs

## Technical Analysis

### Existing MCP Bridge Capabilities

The existing MCP bridge (`src/adapters/shared/bridges/mcp-bridge.ts`) already provides:
- ✅ **Parameter validation** from shared command schemas
- ✅ **Execution context handling** with MCP-specific context
- ✅ **Error handling** and response formatting
- ✅ **Automatic command discovery** from registry
- ✅ **Schema conversion** between shared and MCP formats

### Current MCP Adapter Violations

The current MCP adapters (`src/adapters/mcp/*.ts`) manually duplicate:
- ❌ **Command names and descriptions** (already in shared registry)
- ❌ **Parameter schemas** (Zod objects duplicated)
- ❌ **Validation logic** (required/optional rules duplicated)
- ❌ **Execution handlers** (manual parameter mapping vs bridge)

### Architectural Inconsistency

**CLI Bridge (Working Correctly):**
```typescript
// ✅ CORRECT: CLI uses bridge
registerAllSharedCommands(); // Register shared commands
registerAllCommands(cli);    // Bridge generates CLI commands automatically
```

**MCP Implementation (Broken):**
```typescript
// ❌ WRONG: MCP ignores bridge, duplicates everything manually
commandMapper.addTaskCommand("create", "...", z.object({...}), async (args) => {...});
```

## Requirements

### 1. Fix CLI Bridge Architecture

- **Eliminate CLI factory duplication** by making shared commands work automatically
- **Fix boolean flag handling** so flags like `--no-update` work without manual customizations
- **Remove need for parameter registration in multiple layers** (schema → shared → CLI factory)
- **Ensure CLI bridge properly applies customizations** from shared command registry

### 2. Fix MCP Bridge Architecture

- **Remove manual command registration** from all MCP adapters
- **Replace with automatic registration** from shared command registry using existing bridge
- **Use existing MCP bridge** (`executeMcpCommand`) for all command execution
- **Convert shared command schemas** to MCP-compatible formats automatically

### 3. Establish True Single Source of Truth

- **All command definitions** exist only in shared command registry
- **All parameter schemas** defined once and used by both interfaces  
- **All validation logic** centralized in shared registry
- **Zero duplication** across CLI factory, MCP adapters, and schema layers

### 4. Maintain Interface Compatibility

- **Preserve all existing CLI functionality** including boolean flags
- **Preserve all existing MCP functionality** while eliminating duplication
- **Ensure command names, parameters, and behavior** remain identical
- **Maintain backward compatibility** for existing CLI users and MCP clients

### 5. Establish Automatic Consistency

- **Shared command changes** automatically propagate to both CLI and MCP
- **Parameter additions/removals** automatically reflected in both interfaces
- **Validation changes** automatically applied to both CLI and MCP commands
- **Boolean flag definitions** automatically work in CLI without manual registration

## Implementation Strategy

### Phase 1: Create Bridge Integration Layer

1. **Develop automatic registration utilities**:
   ```typescript
   // New utility: src/adapters/mcp/bridge-integration.ts
   export function registerSharedCommandsWithMCP(
     commandMapper: CommandMapper,
     categories: CommandCategory[]
   ): void {
     categories.forEach(category => {
       const commands = sharedCommandRegistry.getCommandsByCategory(category);
       commands.forEach(command => {
         registerSharedCommandWithMCP(commandMapper, command);
       });
     });
   }
   ```

2. **Create schema conversion utilities**:
   ```typescript
   function convertSharedParametersToMcpSchema(
     parameters: CommandParameterMap
   ): z.ZodObject<any> {
     // Convert shared parameter definitions to MCP Zod schemas
   }
   ```

### Phase 2: Replace Manual Command Registration

1. **Remove all manual command definitions** from:
   - `src/adapters/mcp/tasks.ts`
   - `src/adapters/mcp/session.ts` 
   - `src/adapters/mcp/git.ts`
   - `src/adapters/mcp/rules.ts`

2. **Replace with automatic registration**:
   ```typescript
   // New approach
   export function registerTaskTools(commandMapper: CommandMapper): void {
     registerSharedCommandsWithMCP(commandMapper, [CommandCategory.TASKS]);
   }
   ```

### Phase 3: Integration and Testing

1. **Verify functional equivalence** with existing MCP interface
2. **Test all command parameters** and validation logic
3. **Ensure error handling** works correctly through bridge
4. **Validate automatic updates** when shared commands change

## Success Criteria

### Elimination of Duplication
- [ ] **Zero parameter definitions** duplicated across CLI factory, MCP adapters, and schema layers
- [ ] **Zero validation logic** duplicated across interfaces  
- [ ] **Zero execution handlers** manually implemented in MCP adapters
- [ ] **Zero CLI factory customizations** required for basic parameter handling
- [ ] **Reduced lines of code** in MCP adapter files (>80% reduction expected)
- [ ] **Reduced lines of code** in CLI factory customizations (>50% reduction expected)

### Critical Bug Fixes
- [ ] **`--no-update` flag works correctly** for `session pr` command
- [ ] **All boolean flags work consistently** across CLI commands without manual registration
- [ ] **MCP commands work identically** to current implementation but without duplication
- [ ] **Parameter validation behaves exactly the same** for both CLI and MCP

### Automatic Consistency
- [ ] **Shared command parameter changes** automatically reflected in both CLI and MCP
- [ ] **New shared commands** automatically available in both interfaces
- [ ] **Command description updates** automatically propagated to both CLI and MCP
- [ ] **Validation rule changes** automatically applied to both interfaces
- [ ] **Boolean flag definitions** automatically work in CLI without manual steps

### Functional Equivalence
- [ ] **All existing CLI commands** continue to work identically including flags
- [ ] **All existing MCP commands** continue to work identically
- [ ] **Parameter validation** behaves exactly the same for both interfaces
- [ ] **Error messages** remain consistent with current implementation
- [ ] **Response formats** unchanged for backward compatibility

### Architectural Integrity
- [ ] **Single source of truth** established for all command definitions
- [ ] **Interface agnostic design** properly implemented for both CLI and MCP
- [ ] **DRY principle** enforced across all interfaces and layers
- [ ] **Bridge pattern** correctly utilized for both CLI and MCP integration
- [ ] **No manual registration required** for new commands in either interface

## Verification

### Automated Testing
- [ ] **Unit tests** verify automatic command registration
- [ ] **Integration tests** confirm MCP bridge functionality
- [ ] **Regression tests** ensure existing MCP behavior preserved
- [ ] **Schema conversion tests** validate parameter mapping accuracy

### Manual Verification
- [ ] **MCP inspector** shows identical command definitions
- [ ] **Parameter validation** works exactly as before
- [ ] **Error handling** provides same error messages
- [ ] **Command execution** produces identical results

### Code Quality Metrics
- [ ] **Lines of code reduction** in MCP adapters (target: >80%)
- [ ] **Duplication elimination** verified by static analysis
- [ ] **Dependency analysis** confirms proper bridge usage
- [ ] **Architecture compliance** validated through code review

## Implementation Steps

### Step 1: Analysis and Planning
- [ ] Audit all current MCP command definitions for duplication patterns
- [ ] Map shared command registry entries to MCP command equivalents
- [ ] Design schema conversion utilities for parameter mapping
- [ ] Plan migration strategy to minimize disruption

### Step 2: Bridge Integration Infrastructure
- [ ] Create `src/adapters/mcp/bridge-integration.ts` with registration utilities
- [ ] Implement schema conversion functions for shared → MCP parameter mapping
- [ ] Add automatic command discovery and registration logic
- [ ] Create integration layer between MCP bridge and CommandMapper

### Step 3: Replace Tasks Commands
- [ ] Remove manual task command definitions from `src/adapters/mcp/tasks.ts`
- [ ] Replace with automatic registration from shared command registry
- [ ] Test all task commands through MCP interface
- [ ] Verify parameter validation and error handling

### Step 4: Replace Session Commands  
- [ ] Remove manual session command definitions from `src/adapters/mcp/session.ts`
- [ ] Replace with automatic registration from shared command registry
- [ ] Test all session commands through MCP interface
- [ ] Verify functional equivalence with previous implementation

### Step 5: Replace Git Commands
- [ ] Remove manual git command definitions from `src/adapters/mcp/git.ts`
- [ ] Replace with automatic registration from shared command registry
- [ ] Test all git commands through MCP interface
- [ ] Verify command behavior matches previous implementation

### Step 6: Replace Rules Commands
- [ ] Remove manual rules command definitions from `src/adapters/mcp/rules.ts`
- [ ] Replace with automatic registration from shared command registry
- [ ] Test all rules commands through MCP interface
- [ ] Verify parameter handling and response formatting

### Step 7: Integration and Testing
- [ ] Run comprehensive test suite to verify no regressions
- [ ] Test MCP interface with real MCP clients
- [ ] Verify automatic updates when shared commands change
- [ ] Document the new architecture and usage patterns

### Step 8: Cleanup and Documentation
- [ ] Remove all unused manual command registration code
- [ ] Update MCP adapter documentation to reflect new architecture
- [ ] Add examples of how shared command changes automatically propagate
- [ ] Create migration guide for future MCP adapter development

## Risk Mitigation

### Backward Compatibility
- **Risk**: MCP interface changes break existing clients
- **Mitigation**: Extensive testing with MCP inspector and real clients

### Schema Conversion Issues
- **Risk**: Parameter mapping introduces validation bugs  
- **Mitigation**: Comprehensive unit tests for schema conversion utilities

### Performance Impact
- **Risk**: Bridge layer adds execution overhead
- **Mitigation**: Performance testing and optimization of bridge integration

### Migration Complexity
- **Risk**: Large-scale refactoring introduces bugs
- **Mitigation**: Incremental migration with testing at each step

This task is critical for maintaining architectural integrity and preventing future maintenance overhead. The current duplication violates fundamental software engineering principles and must be eliminated. 
