# Task #270: Restructure and improve test architecture for clarity and maintainability

## 🎯 **Objective**

Reorganize test structure, improve naming conventions, and create clear architectural boundaries to prevent future confusion between **domain function tests** and **adapter tests**, based on learnings from Task #244.

## 📊 **Current Problem**

### **Architectural Confusion Discovered in Task #244:**
- **`*FromParams` functions** are domain functions, not adapter functions
- **Integration tests** were incorrectly classified as "adapter tests"
- **Test location** (`adapters/__tests__/integration/`) suggests adapter testing but actually tests domain functions
- **Test naming** doesn't clearly indicate what layer is being tested

### **Key Learning from Task #244:**
```
❌ WRONG: "Integration tests test adapter layers"
✅ CORRECT: "Integration tests test domain function workflows"
```

## 🏗️ **Current Test Architecture Analysis**

### **Test Organization Issues:**
```
src/
├── adapters/__tests__/
│   ├── integration/          # ❌ CONFUSING: Tests domain functions
│   │   ├── tasks.test.ts     # ✅ VALUABLE: Tests getTaskFromParams domain logic
│   │   ├── session.test.ts   # ✅ VALUABLE: Tests session domain workflows
│   │   └── git.test.ts       # ✅ VALUABLE: Tests git domain workflows
│   └── shared/commands/      # ❌ MIXED: Some domain, some adapter
│       ├── tasks.test.ts     # ✅ CONVERTED: Now tests domain functions
│       └── git.test.ts       # ✅ CONVERTED: Now tests domain functions
├── domain/__tests__/         # ✅ CLEAR: Tests domain services
│   ├── tasks/                # ✅ CLEAR: Tests TaskService, etc.
│   └── session/              # ✅ CLEAR: Tests SessionDB, etc.
└── utils/__tests__/          # ✅ CLEAR: Tests utilities
```

### **The Interface-Agnostic Command Architecture:**
```
CLI Adapter  ┐
            ├──► *FromParams Functions ──► Domain Services
MCP Adapter  ┘    (Domain Layer)              (Data Layer)
(Interface Layer)
```

**Problem:** Tests are organized by **interface** but should be organized by **architectural layer**.

## 🎯 **Proposed Test Architecture**

### **Layer-Based Organization:**
```
src/
├── __tests__/                # 🆕 NEW: Top-level test organization
│   ├── domain/               # ✅ Domain function tests
│   │   ├── commands/         # 🆕 *FromParams function tests
│   │   │   ├── tasks.test.ts        # Tests getTaskFromParams, setTaskStatusFromParams
│   │   │   ├── session.test.ts      # Tests getSessionFromParams, startSessionFromParams
│   │   │   └── git.test.ts          # Tests commitChangesFromParams, pushFromParams
│   │   ├── services/         # ✅ Domain service tests
│   │   │   ├── taskService.test.ts  # Tests TaskService.getTask, etc.
│   │   │   └── sessionDB.test.ts    # Tests SessionDB methods
│   │   └── workflows/        # 🆕 Complex business workflow tests
│   │       ├── session-lifecycle.test.ts
│   │       └── task-lifecycle.test.ts
│   ├── adapters/             # ✅ Pure adapter tests (minimal)
│   │   ├── cli/              # CLI-specific formatting, parsing
│   │   └── mcp/              # MCP-specific protocol handling
│   └── utils/                # ✅ Utility function tests
├── domain/                   # Domain implementation
└── adapters/                 # Adapter implementation
```

## 📋 **Specific Improvements Needed**

### **1. Relocate Domain Function Tests**
- **Move** `adapters/__tests__/integration/` → `__tests__/domain/commands/`
- **Rename** to clearly indicate domain function testing
- **Update** imports and references

### **2. Create Clear Test Categories**
```typescript
// ✅ Domain Command Tests (NEW category)
describe("Task Domain Commands", () => {
  test("getTaskFromParams validates and retrieves task", async () => {
    // Test business logic, validation, service orchestration
  });
});

// ✅ Domain Service Tests (EXISTING, good)
describe("TaskService", () => {
  test("getTask retrieves task from backend", async () => {
    // Test data operations
  });
});

// ✅ Pure Adapter Tests (RARE, interface-specific only)
describe("CLI Task Adapter", () => {
  test("formats task output for CLI display", () => {
    // Test CLI-specific formatting only
  });
});
```

### **3. Improve Test Naming Conventions**
- **Domain Command Tests:** `[module].commands.test.ts`
- **Domain Service Tests:** `[service].service.test.ts`
- **Adapter Tests:** `[interface].[module].adapter.test.ts`
- **Workflow Tests:** `[workflow].workflow.test.ts`

### **4. Create Test Architecture Documentation**
```markdown
# Test Architecture Guide

## Test Categories

### Domain Command Tests
- **Purpose:** Test *FromParams functions (business logic layer)
- **Location:** `__tests__/domain/commands/`
- **Tests:** Parameter validation, service orchestration, business rules
- **Example:** `getTaskFromParams` validation and workflow

### Domain Service Tests
- **Purpose:** Test core domain services (data operation layer)
- **Location:** `domain/__tests__/`
- **Tests:** Data operations, business logic, service methods
- **Example:** `TaskService.getTask` data retrieval

### Adapter Tests
- **Purpose:** Test interface-specific concerns only
- **Location:** `__tests__/adapters/`
- **Tests:** Format conversion, protocol handling, UI concerns
- **Example:** CLI output formatting, MCP protocol compliance
```

## 🔧 **Implementation Strategy**

### **Phase 1: Reorganization**
1. **Create new test directory structure**
2. **Move domain function tests** to appropriate locations
3. **Update imports** and test discovery
4. **Verify all tests still run** and pass

### **Phase 2: Improve Naming and Documentation**
1. **Rename test files** to follow new conventions
2. **Update test descriptions** to clarify what's being tested
3. **Add architecture documentation**
4. **Create examples** of each test category

### **Phase 3: Test Quality Improvements**
1. **Review moved tests** for actual domain logic focus
2. **Split tests** that mix domain and adapter concerns
3. **Add missing domain function tests** if any gaps
4. **Improve test utilities** for domain function testing

### **Phase 4: Prevention Measures**
1. **Add ESLint rules** for test organization
2. **Update development guidelines** with test architecture
3. **Add PR review guidelines** for test classification
4. **Create test templates** for each category

## 🎯 **Success Criteria**

### **Organizational Clarity:**
- [ ] **Clear separation** between domain function and adapter tests
- [ ] **Intuitive test locations** based on architectural layer
- [ ] **Consistent naming** conventions across all test types
- [ ] **No more confusion** about what tests are testing

### **Developer Experience:**
- [ ] **Easy to find** tests for any given functionality
- [ ] **Clear examples** of how to test each layer
- [ ] **Documented patterns** for common test scenarios
- [ ] **Fast test discovery** and execution

### **Test Quality:**
- [ ] **Same or better** test coverage after reorganization
- [ ] **Faster test execution** with better organization
- [ ] **Clearer test failures** with better naming
- [ ] **Maintainable tests** with proper structure

## 📚 **Documentation Deliverables**

### **Test Architecture Guide:**
- **Overview** of test organization philosophy
- **Layer definitions** and responsibilities
- **Test category examples** with code samples
- **Best practices** for each test type

### **Migration Guide:**
- **Step-by-step** instructions for moving tests
- **Import update** patterns
- **Common issues** and solutions
- **Verification** steps

### **Development Guidelines:**
- **How to choose** test category for new tests
- **Naming conventions** for test files and descriptions
- **Test utilities** and helpers available
- **Review criteria** for test PRs

## 🔄 **Relationship to Other Tasks**

### **Builds on Task #244:**
- Task #244 discovered the architectural confusion
- Task #270 fixes the structural issues causing confusion
- Same test suite, better organization

### **Complements Tasks #268 & #269:**
- Task #268: Remove remaining testing-boundaries violations
- Task #269: Fix test isolation and global state issues
- Task #270: Improve test architecture and organization
- **Together:** Complete test suite improvement

## 📈 **Expected Benefits**

### **Short-term:**
- **Eliminate confusion** about test categorization
- **Improve test discoverability** and maintainability
- **Clearer understanding** of what each test validates
- **Better development experience** with organized tests

### **Long-term:**
- **Prevent future architectural confusion**
- **Faster onboarding** for new developers
- **Maintainable test growth** with clear patterns
- **Foundation for advanced testing** (parallel execution, etc.)

## 🛠️ **Implementation Details**

### **Directory Migration:**
```bash
# Move domain function tests
mv src/adapters/__tests__/integration/tasks.test.ts src/__tests__/domain/commands/
mv src/adapters/__tests__/integration/session.test.ts src/__tests__/domain/commands/
mv src/adapters/__tests__/integration/git.test.ts src/__tests__/domain/commands/
```

### **Test Discovery Update:**
```javascript
// Update test configuration to find tests in new locations
{
  "testMatch": [
    "**/__tests__/**/*.test.ts",
    "**/src/**/*.test.ts"
  ]
}
```

### **Import Updates:**
```typescript
// Update imports to reflect new test locations
import { getTaskFromParams } from "../../domain/tasks/taskCommands.js";
```

---

## 📝 **Action Items**

1. **Design new test directory structure** based on architectural layers
2. **Create migration plan** for existing tests
3. **Move domain function tests** to appropriate locations
4. **Update all imports** and test discovery
5. **Verify test execution** and fix any issues
6. **Document new architecture** and patterns
7. **Update development guidelines** and PR review criteria

**Priority:** HIGH - Critical for preventing future architectural confusion
**Complexity:** MEDIUM - Systematic reorganization and documentation
**Impact:** HIGH - Improves developer experience and test maintainability
