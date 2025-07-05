# Fix Shared Command Registry Architecture to Eliminate Interface Duplication

## Context

The shared command registry architecture is fundamentally broken, causing duplication and inconsistencies across both CLI and MCP interfaces. This architectural failure manifests in two critical ways:

1. **MCP Interface**: Completely bypasses the existing MCP bridge, manually duplicating all command definitions
2. **CLI Interface**: Requires manual parameter registration in multiple layers, breaking boolean flag handling

This creates a maintenance nightmare and defeats the purpose of the shared command registry as a single source of truth.

## 📊 DETAILED ARCHITECTURE ANALYSIS

After comprehensive codebase exploration, I've identified the exact scope and nature of the duplication problems:

### Current Working Architecture (CLI)

**✅ CLI Bridge Works Correctly:**

- `src/adapters/shared/bridges/cli-bridge.ts` - Successfully converts shared commands to CLI commands
- `src/adapters/cli/cli-command-factory.ts` - Provides customization layer with proper parameter mapping
- `src/cli.ts` - Uses bridge pattern: `registerAllSharedCommands()` → `registerAllCommands(cli)`

### Current Broken Architecture (MCP)

**❌ MCP Bridge Exists But Is Completely Ignored:**

- `src/adapters/shared/bridges/mcp-bridge.ts` - Has `executeMcpCommand` function that could work
- `src/adapters/mcp/*.ts` - All adapters completely bypass the bridge and manually duplicate everything
- `src/mcp/command-mapper.ts` - Uses `addTaskCommand`, `addSessionCommand`, etc. for manual registration

### Duplication Evidence

**1. Tasks Commands Duplication:**

**Shared Definition** (`src/adapters/shared/commands/tasks.ts`):

```typescript
const tasksListParams: CommandParameterMap = {
  filter: { schema: z.string(), description: "Filter by task status", required: false },
  all: {
    schema: z.boolean().default(false),
    description: "Include completed tasks",
    required: false,
  },
  backend: { schema: z.string(), description: "Specify task backend", required: false },
  // ... 6 more parameters
};
```

**MCP Duplication** (`src/adapters/mcp/tasks.ts`):

```typescript
commandMapper.addTaskCommand(
  "list",
  "List all tasks", // DUPLICATED DESCRIPTION
  z.object({
    filter: z.string().optional().describe("Filter tasks by status or other criteria"), // DUPLICATED PARAM
    all: z.boolean().optional().describe("Include completed tasks"), // DUPLICATED PARAM
    backend: z.string().optional().describe("Task backend type"), // DUPLICATED PARAM
    // ... same parameters duplicated with slightly different descriptions
  }),
  async (args: any) => {
    // DUPLICATED EXECUTION LOGIC
    const tasks = await listTasksFromParams(params);
    return { tasks };
  }
);
```

**2. Session Commands Duplication:**

**Shared Definition** (`src/adapters/shared/commands/session.ts`):

```typescript
const sessionStartCommandParams: CommandParameterMap = {
  name: { schema: z.string().min(1), description: "Name for the new session", required: false },
  task: { schema: z.string(), description: "Task ID to associate", required: false },
  description: {
    schema: z.string().min(1),
    description: "Description for auto-created task",
    required: false,
  },
  // ... 8 more parameters
};
```

**MCP Duplication** (`src/adapters/mcp/session.ts`):

```typescript
commandMapper.addSessionCommand(
  "start",
  "Start a new session", // DUPLICATED DESCRIPTION
  z.object({
    name: z.string().optional().describe("Name for the session"), // DUPLICATED PARAM
    task: z.string().optional().describe("Task ID to associate with the session"), // DUPLICATED PARAM
    description: z.string().optional().describe("Description for auto-created task"), // DUPLICATED PARAM
    // ... same parameters with validation logic duplicated
  }),
  async (args): Promise<Record<string, unknown>> => {
    // DUPLICATED VALIDATION LOGIC
    if (!args.task && !args.description) {
      throw new Error("Task association is required...");
    }
    // DUPLICATED EXECUTION LOGIC
    const session = await startSessionFromParams(params);
    return { success: true, session };
  }
);
```

**3. Git Commands Duplication:**

**Shared Definition** (`src/adapters/shared/commands/git.ts`):

```typescript
const prCommandParams: CommandParameterMap = {
  session: { schema: z.string(), description: SESSION_DESCRIPTION, required: false },
  repo: { schema: z.string(), description: REPO_DESCRIPTION, required: false },
  branch: { schema: z.string(), description: GIT_BRANCH_DESCRIPTION, required: false },
  task: { schema: z.string(), description: TASK_ID_DESCRIPTION, required: false },
  debug: { schema: z.boolean().default(false), description: DEBUG_DESCRIPTION, required: false },
  noStatusUpdate: {
    schema: z.boolean().default(false),
    description: NO_STATUS_UPDATE_DESCRIPTION,
    required: false,
  },
};
```

**MCP Duplication** (`src/adapters/mcp/git.ts`):

```typescript
commandMapper.addGitCommand(
  "pr",
  "Create a pull request", // DUPLICATED DESCRIPTION
  z.object({
    _session: z.string().optional().describe(SESSION_DESCRIPTION), // DUPLICATED PARAM (with underscore!)
    repo: z.string().optional().describe(REPO_DESCRIPTION), // DUPLICATED PARAM
    branch: z.string().optional().describe(GIT_BRANCH_DESCRIPTION), // DUPLICATED PARAM
    task: z.string().optional().describe(TASK_ID_DESCRIPTION), // DUPLICATED PARAM
    debug: z.boolean().optional().describe(DEBUG_DESCRIPTION), // DUPLICATED PARAM
    noStatusUpdate: z.boolean().optional().describe(NO_STATUS_UPDATE_DESCRIPTION), // DUPLICATED PARAM
  }),
  async (args) => {
    // DUPLICATED PARAMETER MAPPING
    const params = {
      ...args,
      taskId: args.task, // Manual parameter mapping
      json: true, // Manual format setting
    };
    // DUPLICATED EXECUTION LOGIC
    const result = await createPullRequestFromParams(params);
    return { success: true, markdown: result.markdown };
  }
);
```

### Quantified Duplication Scale

**Files with 100% Command Duplication:**

- `src/adapters/mcp/tasks.ts` - 6 commands, ~200 lines of duplication
- `src/adapters/mcp/session.ts` - 7 commands, ~300 lines of duplication
- `src/adapters/mcp/git.ts` - 5 commands, ~150 lines of duplication
- `src/adapters/mcp/rules.ts` - ~300 lines of duplication

**Total Estimated Duplication:** 1000+ lines of duplicated command definitions, parameter schemas, validation logic, and execution handlers.

### CLI Boolean Flag Issue Analysis

The CLI factory (`src/adapters/cli/cli-command-factory.ts`) shows proper customization for `session.pr` command:

```typescript
"session.pr": {
  parameters: {
    noStatusUpdate: {
      description: "Skip updating task status",
    },
  },
},
```

However, the issue may be in parameter mapping or CLI bridge configuration not properly handling boolean flags. The shared command definition uses `noStatusUpdate` with `z.boolean().default(false)`, which should work correctly.

## IMPLEMENTATION STRATEGY

### Phase 1: Create MCP Bridge Integration Utilities

**1.1 Automatic MCP Command Registration Utility**

Create `src/adapters/mcp/bridge-integration.ts`:

```typescript
import { sharedCommandRegistry, CommandCategory } from "../shared/command-registry";
import { CommandMapper } from "../../mcp/command-mapper";
import { executeMcpCommand } from "../shared/bridges/mcp-bridge";

/**
 * Register all shared commands from a category with MCP automatically
 */
export function registerSharedCommandsWithMCP(
  commandMapper: CommandMapper,
  category: CommandCategory
): void {
  const commands = sharedCommandRegistry.getCommandsByCategory(category);

  commands.forEach((command) => {
    registerSharedCommandWithMCP(commandMapper, command);
  });
}

/**
 * Register a single shared command with MCP using the bridge
 */
function registerSharedCommandWithMCP(commandMapper: CommandMapper, command: SharedCommand): void {
  // Convert shared parameters to MCP Zod schema
  const mcpSchema = convertSharedParametersToMcpSchema(command.parameters);

  // Register using CommandMapper
  commandMapper.addCommand({
    name: command.id,
    description: command.description,
    parameters: mcpSchema,
    execute: async (args) => {
      // Use existing MCP bridge for execution
      return await executeMcpCommand({
        commandId: command.id,
        parameters: args,
      });
    },
  });
}
```

**1.2 Schema Conversion Utility**

```typescript
/**
 * Convert shared command parameters to MCP-compatible Zod schema
 */
function convertSharedParametersToMcpSchema(parameters: CommandParameterMap): z.ZodObject<any> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, param] of Object.entries(parameters)) {
    let schema = param.schema;

    // Make optional if not required
    if (!param.required) {
      schema = schema.optional();
    }

    // Add description
    if (param.description) {
      schema = schema.describe(param.description);
    }

    shape[key] = schema;
  }

  return z.object(shape);
}
```

### Phase 2: Replace Manual MCP Command Registration

**2.1 Tasks Commands** (`src/adapters/mcp/tasks.ts`):

**BEFORE (Manual, 230 lines):**

```typescript
export function registerTaskTools(commandMapper: CommandMapper): void {
  commandMapper.addTaskCommand("list", "List all tasks", z.object({...}), async (args) => {...});
  commandMapper.addTaskCommand("get", "Get a task by ID", z.object({...}), async (args) => {...});
  commandMapper.addTaskCommand("status.get", "Get task status", z.object({...}), async (args) => {...});
  commandMapper.addTaskCommand("status.set", "Set task status", z.object({...}), async (args) => {...});
  commandMapper.addTaskCommand("create", "Create a task", z.object({...}), async (args) => {...});
  commandMapper.addTaskCommand("delete", "Delete a task", z.object({...}), async (args) => {...});
}
```

**AFTER (Automatic, ~20 lines):**

```typescript
import { registerSharedCommandsWithMCP } from "./bridge-integration";
import { CommandCategory } from "../shared/command-registry";

export function registerTaskTools(commandMapper: CommandMapper): void {
  registerSharedCommandsWithMCP(commandMapper, CommandCategory.TASKS);
}
```

**2.2 Session Commands** (`src/adapters/mcp/session.ts`):

**BEFORE (Manual, 340 lines):**

```typescript
export function registerSessionTools(commandMapper: CommandMapper): void {
  // 7 manually defined commands with full duplication
}
```

**AFTER (Automatic, ~20 lines):**

```typescript
export function registerSessionTools(commandMapper: CommandMapper): void {
  registerSharedCommandsWithMCP(commandMapper, CommandCategory.SESSION);
}
```

**2.3 Git Commands** (`src/adapters/mcp/git.ts`):

**BEFORE (Manual, 160 lines):**

```typescript
export function registerGitTools(commandMapper: CommandMapper): void {
  // 5 manually defined commands with full duplication
}
```

**AFTER (Automatic, ~20 lines):**

```typescript
export function registerGitTools(commandMapper: CommandMapper): void {
  registerSharedCommandsWithMCP(commandMapper, CommandCategory.GIT);
}
```

### Phase 3: CLI Boolean Flag Investigation and Fix

**3.1 Investigate CLI Bridge Parameter Mapping**

Test boolean flag handling in `src/adapters/shared/bridges/cli-bridge.ts` parameter mapper:

- Verify `z.boolean().default(false)` maps correctly to `--no-status-update` flag
- Check CLI factory customizations are applied correctly
- Test end-to-end: `minsky session pr --no-status-update`

**3.2 Fix Any CLI Bridge Issues Found**

If CLI bridge has boolean flag issues, fix in parameter mapping logic in `cli-bridge.ts`.

### Phase 4: Integration and Testing

**4.1 Comprehensive Testing**

- MCP interface: Test all commands work identically to current implementation
- CLI interface: Test boolean flags work correctly
- Parameter validation: Verify all validation rules work the same
- Error handling: Ensure error messages remain consistent

**4.2 Rollback Plan**

- Keep existing MCP adapter files as backup during migration
- Test each command category independently
- Rollback if any functional regressions detected

## SUCCESS CRITERIA

### Elimination of Duplication

- [ ] **Zero parameter definitions** duplicated (currently ~50+ duplicated parameters)
- [ ] **Zero validation logic** duplicated (currently ~20+ validation rules duplicated)
- [ ] **Zero execution handlers** manually implemented in MCP (currently ~20+ manual handlers)
- [ ] **80%+ reduction in MCP adapter file sizes** (from 1000+ lines to ~100 lines total)

### Critical Bug Fixes

- [ ] **`--no-status-update` flag works correctly** for `session pr` command
- [ ] **All boolean flags work consistently** across CLI commands
- [ ] **MCP commands work identically** to current implementation
- [ ] **Parameter validation behaves exactly the same**

### Automatic Consistency

- [ ] **Shared command changes automatically reflected** in both CLI and MCP
- [ ] **New shared commands automatically available** in both interfaces
- [ ] **Command descriptions automatically synchronized**
- [ ] **Validation rules automatically applied** to both interfaces

### Functional Equivalence

- [ ] **All existing CLI commands continue working identically**
- [ ] **All existing MCP commands continue working identically**
- [ ] **Parameter validation behaves exactly the same**
- [ ] **Error messages remain consistent**
- [ ] **Response formats unchanged**

## IMPLEMENTATION STEPS

### Step 1: Create Bridge Integration Infrastructure

- [ ] Create `src/adapters/mcp/bridge-integration.ts` with automatic registration utilities
- [ ] Implement schema conversion functions for shared → MCP parameter mapping
- [ ] Add automatic command discovery and registration logic
- [ ] Create integration layer between existing MCP bridge and CommandMapper

### Step 2: Replace Tasks Commands (Test Case)

- [ ] Backup current `src/adapters/mcp/tasks.ts`
- [ ] Replace with automatic registration from shared command registry
- [ ] Test all task commands through MCP interface
- [ ] Verify parameter validation and error handling work identically
- [ ] Confirm 80%+ reduction in file size (230 lines → ~20 lines)

### Step 3: Replace Session Commands

- [ ] Backup current `src/adapters/mcp/session.ts`
- [ ] Replace with automatic registration
- [ ] Test all session commands through MCP interface
- [ ] Verify functional equivalence with previous implementation
- [ ] Confirm 90%+ reduction in file size (340 lines → ~20 lines)

### Step 4: Replace Git Commands

- [ ] Backup current `src/adapters/mcp/git.ts`
- [ ] Replace with automatic registration
- [ ] Test all git commands through MCP interface
- [ ] Verify command behavior matches previous implementation
- [ ] Confirm 85%+ reduction in file size (160 lines → ~20 lines)

### Step 5: Replace Rules Commands

- [ ] Backup current `src/adapters/mcp/rules.ts`
- [ ] Replace with automatic registration
- [ ] Test all rules commands through MCP interface
- [ ] Verify parameter handling and response formatting work correctly

### Step 6: CLI Boolean Flag Investigation and Fix

- [ ] Test `minsky session pr --no-status-update` functionality
- [ ] Investigate CLI bridge boolean parameter mapping if issues found
- [ ] Fix any CLI factory customization issues
- [ ] Verify all boolean flags work consistently across commands

### Step 7: Integration Testing and Cleanup

- [ ] Run comprehensive test suite to verify no regressions
- [ ] Test MCP interface with real MCP clients (MCP inspector)
- [ ] Verify automatic updates when shared commands change
- [ ] Remove backup files and update documentation

### Step 8: Architecture Documentation

- [ ] Document new bridge integration architecture
- [ ] Add examples of how shared command changes automatically propagate
- [ ] Create migration guide for future MCP adapter development
- [ ] Update architectural documentation

## RISK MITIGATION

### Backward Compatibility

- **Risk**: MCP interface changes break existing clients
- **Mitigation**: Extensive testing with MCP inspector and real clients
- **Rollback**: Keep backup files during migration

### Schema Conversion Issues

- **Risk**: Parameter mapping introduces validation bugs
- **Mitigation**: Comprehensive unit tests for schema conversion utilities
- **Validation**: Test identical parameter validation between old and new implementations

### Performance Impact

- **Risk**: Bridge layer adds execution overhead
- **Mitigation**: Performance testing and optimization of bridge integration
- **Baseline**: Measure current MCP command execution times

### Migration Complexity

- **Risk**: Large-scale refactoring introduces bugs
- **Mitigation**: Incremental migration with testing at each step
- **Safety**: Test each command category independently before proceeding

This task is critical for maintaining architectural integrity and preventing future maintenance overhead. The current duplication violates fundamental software engineering principles and must be eliminated to ensure the codebase remains maintainable.
