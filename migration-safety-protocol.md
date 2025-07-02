# Migration Safety Protocol

## Critical Error Analysis: Task 209 Configuration Migration

### What Went Wrong
During the configuration system migration, I removed the `backend-detector.ts` file and its associated logic without:
1. **Understanding its dependencies** - Failed to identify that `createConfiguredTaskService()` relied on backend detection
2. **Testing impact** - Did not verify that auto-detection functionality was preserved
3. **Mapping functionality** - Did not create a comprehensive map of what the old system provided
4. **Gradual migration** - Attempted to remove everything at once instead of incrementally

### Root Cause
**Error Category**: [x] Verification Error - Failed to validate before proceeding
**Specific Failure**: Removed essential functionality without understanding its role in the system
**Process Violation**: Did not follow "preserve functionality first, optimize second" principle

## Mandatory Migration Safety Protocol

### Phase 1: Functionality Mapping (REQUIRED)
Before removing ANY code during a migration:

1. **Create Functionality Inventory**:
   ```bash
   # Document all public functions/exports
   grep -r "export" src/path/to/old-system/ > functionality-inventory.txt
   
   # Find all usage locations
   grep -r "import.*from.*old-system" src/ > usage-locations.txt
   
   # Document what each component does
   echo "Component: X, Purpose: Y, Dependencies: Z" >> component-purposes.txt
   ```

2. **Dependency Analysis**:
   - Map what calls each function/class
   - Identify transitive dependencies
   - Document data flow through the system
   - Check for implicit dependencies (config, environment, etc.)

3. **Test Coverage Verification**:
   ```bash
   # Run tests to establish baseline
   bun test > pre-migration-test-results.txt
   
   # Identify which tests cover the functionality being migrated
   grep -r "old-system-component" src/**/*.test.ts
   ```

### Phase 2: Incremental Migration (REQUIRED)
Never remove entire subsystems at once:

1. **Create Compatibility Layer**:
   - Build new system alongside old system
   - Create adapters/wrappers to maintain existing interfaces
   - Ensure new system provides identical functionality

2. **Gradual Replacement**:
   - Replace one usage location at a time
   - Verify tests pass after each replacement
   - Keep old system intact until ALL usages are migrated

3. **Verification at Each Step**:
   ```bash
   # After each migration step
   bun test
   ./verify-functionality.ts
   git commit -m "Migrate component X - tests passing"
   ```

### Phase 3: Verification Before Removal (MANDATORY)
Before deleting ANY files:

1. **Zero Usage Verification**:
   ```bash
   # Verify NO remaining imports
   grep -r "old-component" src/ | grep -v ".disabled" | grep -v ".backup"
   
   # If ANY results found, migration is NOT complete
   ```

2. **Comprehensive Testing**:
   ```bash
   # All tests must pass
   bun test
   
   # Integration tests must verify functionality
   ./verify-end-to-end-functionality.ts
   
   # Manual verification of key workflows
   ```

3. **Rollback Preparation**:
   ```bash
   # Create rollback branch before deletion
   git checkout -b rollback-point-before-deletion
   git checkout main
   
   # Document rollback procedure
   echo "To rollback: git checkout rollback-point-before-deletion" > ROLLBACK.md
   ```

## Critical Checkpoints

### Before Starting Migration
- [ ] Functionality inventory completed
- [ ] All usage locations identified
- [ ] Test baseline established
- [ ] Migration plan documented with incremental steps

### Before Each Step
- [ ] Current step clearly defined
- [ ] Expected outcome documented
- [ ] Rollback plan for this step identified
- [ ] Tests passing before change

### After Each Step
- [ ] Tests still passing
- [ ] Functionality verification completed
- [ ] Changes committed with clear message
- [ ] Next step planned

### Before Final Deletion
- [ ] Zero usage verification completed (grep results empty)
- [ ] All tests passing
- [ ] End-to-end functionality verified
- [ ] Rollback branch created
- [ ] Migration documented

## Emergency Recovery Protocol

If critical functionality is discovered missing after deletion:

1. **Immediate Assessment**:
   ```bash
   # Check if rollback branch exists
   git branch --list | grep rollback
   
   # Document current broken state
   ./document-current-state.ts > broken-state.json
   ```

2. **Rapid Recovery**:
   ```bash
   # Option 1: Rollback to known good state
   git checkout rollback-point-before-deletion
   
   # Option 2: Cherry-pick specific functionality
   git checkout rollback-point -- path/to/needed/file.ts
   ```

3. **Proper Re-migration**:
   - Follow full protocol from Phase 1
   - Do not attempt shortcuts
   - Create comprehensive tests for the missing functionality
   - Document the recovery in migration notes

## Prevention Mechanisms

### Automated Checks
Create scripts that MUST pass before any deletion:

```typescript
// verify-safe-to-delete.ts
export async function verifySafeToDelete(componentPath: string): Promise<boolean> {
  // Check for remaining imports
  const usageLocations = await findUsageLocations(componentPath);
  if (usageLocations.length > 0) {
    console.error(`Cannot delete ${componentPath}: still used in:`, usageLocations);
    return false;
  }
  
  // Run tests
  const testsPass = await runTests();
  if (!testsPass) {
    console.error(`Cannot delete ${componentPath}: tests failing`);
    return false;
  }
  
  // Verify functionality
  const functionalityIntact = await verifyCoreFunctionality();
  if (!functionalityIntact) {
    console.error(`Cannot delete ${componentPath}: functionality verification failed`);
    return false;
  }
  
  return true;
}
```

### Rule Updates
This protocol must be applied to:
- **All migration tasks**
- **Any refactoring that removes code**
- **System simplification efforts**
- **Dependency updates that change APIs**

## Integration with Existing Rules

This protocol supplements:
- `test-driven-bugfix` - Use TDD approach for migration verification
- `robust-error-handling` - Handle migration errors gracefully
- `workspace-verification` - Verify workspace state before changes
- `dont-ignore-errors` - Never ignore test failures during migration

## Task 209 Specific Lessons

### What Should Have Been Done
1. **Map all configuration system functionality** before starting
2. **Identify that backend detection was critical** to task service creation
3. **Create compatibility layer** that preserved auto-detection while using node-config
4. **Migrate incrementally** instead of wholesale replacement
5. **Verify end-to-end functionality** before declaring migration complete

### Process Improvements Applied
1. Created comprehensive verification script
2. Restored missing functionality with simplified implementation
3. Documented the error and recovery process
4. Created this protocol to prevent recurrence

## Mandatory Application

This protocol is now REQUIRED for:
- Any task involving code removal or replacement
- System migrations or refactoring
- Dependency changes
- Architecture simplification efforts

**Violation of this protocol constitutes a critical process failure requiring immediate correction and rule updates.** 
