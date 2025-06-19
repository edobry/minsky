# Preventing Architectural Bypass Patterns

This document outlines strategies and patterns to prevent architectural bypass issues, like the recent CLI bridge bypass that caused the `tasks status set` command regression.

## The Problem

In our recent issue, the CLI was configured to use the CLI Command Factory with proper customizations, but the actual CLI initialization was bypassing the factory and using the CLI bridge directly. This meant customizations were set up but never applied.

```typescript
// ❌ What was happening (bypass pattern)
setupCommonCommandCustomizations(cli); // Set up customizations
// ... but then bypass the factory:
const tasksCategoryCommand = cliBridge.generateCategoryCommand(CommandCategory.TASKS);

// ✅ What should happen (proper pattern)
setupCommonCommandCustomizations(cli);
registerAllCommands(cli); // Use the factory that applies customizations
```

## Architectural Safeguards

### 1. Encapsulation and Private Access

**Pattern**: Make internal implementation details private and expose only controlled interfaces.

**Implementation**:

```typescript
// ❌ Before: Direct access to implementation
export const cliBridge = new CliCommandBridge();

// ✅ After: Private implementation, controlled access
const cliBridge = new CliCommandBridge(); // Not exported

class CliCommandFactory {
  // Controlled interface that ensures proper usage
  registerAllCommands(program: Command): void {
    cliBridge.generateAllCategoryCommands(program);
  }
}
```

**Benefits**:

- Prevents direct access to low-level implementation
- Forces usage through the intended interface
- Makes it impossible to accidentally bypass the factory

### 2. Development-Time Warnings

**Pattern**: Add warnings when potentially problematic patterns are detected.

**Implementation**:

```typescript
generateCommand(commandId: string): Command | null {
  // Warn about direct usage in development
  if (process.env.NODE_ENV !== 'production') {
    log.warn(`[CLI Bridge] Direct usage detected for command '${commandId}'. Consider using CLI Command Factory for proper customization support.`);
  }
  // ... rest of implementation
}
```

**Benefits**:

- Alerts developers to potential issues during development
- Doesn't impact production performance
- Provides guidance on proper usage

### 3. Initialization Guards

**Pattern**: Require explicit initialization and fail fast if not properly set up.

**Implementation**:

```typescript
class CliCommandFactory {
  private initialized = false;

  initialize(config?: Partial<CliFactoryConfig>): void {
    this.initialized = true;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "CLI Command Factory must be initialized before use. Call initialize() first."
      );
    }
  }

  registerAllCommands(program: Command): void {
    this.ensureInitialized(); // Fail fast if not initialized
    // ... implementation
  }
}
```

**Benefits**:

- Ensures proper setup before usage
- Provides clear error messages for misconfiguration
- Makes the initialization contract explicit

### 4. Type-Level Constraints

**Pattern**: Use TypeScript's type system to prevent incorrect usage at compile time.

**Implementation**:

```typescript
// Restrict valid command IDs
type ValidCommandId = 'tasks.list' | 'tasks.get' | 'tasks.status.set' | ...; // Union of known IDs

// Prevent direct instantiation
class CliCommandBridge {
  private constructor() {} // Private constructor

  static createInstance(): CliCommandBridge {
    // Only allow creation through controlled factory
    return new CliCommandBridge();
  }
}
```

**Benefits**:

- Compile-time safety
- IDE autocomplete and validation
- Prevents typos and invalid usage

### 5. Facade Pattern

**Pattern**: Provide a simplified interface that hides complex subsystems.

**Implementation**:

```typescript
// ✅ Simple, safe interface
export function initializeCliCommands(program: Command, config?: CliFactoryConfig): void {
  cliFactory.initialize(config);
  setupCommonCommandCustomizations();
  cliFactory.registerAllCommands(program);
}

// ❌ Complex, error-prone manual setup
export function manualSetup(program: Command): void {
  setupCommonCommandCustomizations();
  const tasks = cliBridge.generateCategoryCommand(CommandCategory.TASKS);
  const git = cliBridge.generateCategoryCommand(CommandCategory.GIT);
  // ... easy to forget steps or do them in wrong order
}
```

**Benefits**:

- Reduces complexity for consumers
- Ensures all necessary steps are performed
- Prevents partial or incorrect setup

### 6. Linting Rules

**Pattern**: Use ESLint rules to enforce architectural patterns.

**Implementation**:

```javascript
// .eslintrc.js
module.exports = {
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: ["**/cli-bridge"],
            message: "Use CLI Command Factory instead of direct CLI bridge access",
          },
        ],
      },
    ],
  },
};
```

**Benefits**:

- Automated enforcement
- Catches issues during development
- Educates developers about proper patterns

### 7. Dependency Injection

**Pattern**: Inject dependencies rather than accessing them directly.

**Implementation**:

```typescript
// ❌ Direct dependency access
class SomeCliComponent {
  setupCommands() {
    cliBridge.generateCategoryCommand(CommandCategory.TASKS); // Direct access
  }
}

// ✅ Dependency injection
class SomeCliComponent {
  constructor(private commandFactory: CliCommandFactory) {}

  setupCommands() {
    this.commandFactory.createCategoryCommand(CommandCategory.TASKS);
  }
}
```

**Benefits**:

- Makes dependencies explicit
- Enables testing with mocks
- Reduces coupling

### 8. Builder Pattern for Complex Setup

**Pattern**: Use a builder to ensure all required configuration is provided.

**Implementation**:

```typescript
class CliSetupBuilder {
  private customizations: Map<string, any> = new Map();
  private categories: CommandCategory[] = [];

  addCustomization(commandId: string, options: CliCommandOptions): this {
    this.customizations.set(commandId, options);
    return this;
  }

  addCategory(category: CommandCategory): this {
    this.categories.push(category);
    return this;
  }

  build(program: Command): void {
    if (this.categories.length === 0) {
      throw new Error("At least one category must be specified");
    }
    // Apply all customizations and register commands
  }
}

// Usage
new CliSetupBuilder()
  .addCategory(CommandCategory.TASKS)
  .addCustomization("tasks.status.set", {
    /* options */
  })
  .build(program);
```

**Benefits**:

- Fluent, discoverable API
- Validates configuration before execution
- Prevents incomplete setup

## Testing Strategies

### 1. Integration Tests for Bypass Detection

```typescript
test("CLI should use command factory customizations", async () => {
  const program = new Command();
  setupCommonCommandCustomizations();
  registerAllCommands(program);

  // Test that customizations are applied
  const helpOutput = await getCommandHelp(program, ["tasks", "status", "set", "--help"]);
  expect(helpOutput).toContain("<taskId> [status]"); // Both args should be present
  expect(helpOutput).not.toContain("--status <string>"); // Status should not be an option
});
```

### 2. Architecture Tests

```typescript
test("CLI bridge should not be directly accessible", () => {
  // Ensure the bridge is not exported
  expect(() => {
    require("../cli-bridge").cliBridge;
  }).toThrow();
});
```

## Implementation Checklist

When implementing similar architectural patterns:

- [ ] **Encapsulation**: Make implementation details private
- [ ] **Controlled Interface**: Provide a single, well-defined entry point
- [ ] **Initialization Guards**: Require explicit setup and fail fast
- [ ] **Development Warnings**: Add warnings for bypass patterns
- [ ] **Type Safety**: Use TypeScript to prevent incorrect usage
- [ ] **Documentation**: Document the intended usage pattern
- [ ] **Testing**: Add tests to verify the pattern is followed
- [ ] **Linting**: Add rules to enforce the pattern automatically

## Conclusion

By applying these patterns, we can prevent architectural bypass issues and ensure that our systems work as intended. The key principles are:

1. **Make the right way the easy way**
2. **Make the wrong way hard or impossible**
3. **Fail fast with clear error messages**
4. **Use the type system to enforce correctness**
5. **Test the architecture, not just the functionality**

These safeguards help maintain system integrity and prevent subtle bugs that can be difficult to track down.
