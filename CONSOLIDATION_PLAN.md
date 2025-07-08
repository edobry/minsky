# Codemod Consolidation Plan

## **🗑️ CLEAR DUPLICATES TO REMOVE**

### **TS2322 Duplicates (12+ codemods - Keep ONLY ast-based)**
- [x] fix-ts2322-ast-based.ts ✅ **KEEP** (refactored to utility)
- [ ] fix-ts2322-targeted.ts ❌ **REMOVE** (duplicate)
- [ ] fix-ts2322-type-assignment-errors.ts ❌ **REMOVE** (duplicate)  
- [ ] fix-ts2322-type-assignments-enhanced.ts ❌ **REMOVE** (duplicate)
- [ ] fix-ts2322-type-assignments.ts ❌ **REMOVE** (duplicate)
- [ ] fix-ts2322-final.ts ❌ **REMOVE** (duplicate)
- [ ] fix-ts2322-precise-ast.ts ❌ **REMOVE** (duplicate)
- [ ] fix-ts2322-remaining-ast.ts ❌ **REMOVE** (duplicate)
- [ ] fix-ts2322-remaining.ts ❌ **REMOVE** (duplicate)
- [ ] fix-ts2322-targeted-ast.ts ❌ **REMOVE** (duplicate)
- [ ] fix-ts2322-corrected-patterns.ts ❌ **REMOVE** (duplicate)
- [ ] fix-ts2322-current-patterns.ts ❌ **REMOVE** (duplicate)
- [ ] fix-specific-ts2322-patterns.ts ❌ **REMOVE** (duplicate)
- [ ] fix-ts2322-type-not-assignable.ts ❌ **REMOVE** (duplicate)
- [ ] eliminate-ts2322-completely.ts ❌ **REMOVE** (aggressive/experimental)

### **TS2345 Duplicates (6+ codemods - Keep ONLY argument-errors)**
- [x] fix-ts2345-argument-errors.ts ✅ **KEEP** (refactored to utility)
- [ ] fix-ts2345-argument-types.ts ❌ **REMOVE** (duplicate)
- [ ] fix-ts2345-specific-patterns.ts ❌ **REMOVE** (duplicate)
- [ ] fix-ts2345-targeted.ts ❌ **REMOVE** (duplicate)
- [ ] eliminate-ts2345-completely.ts ❌ **REMOVE** (aggressive/experimental)
- [ ] conservative-ts2345-fixer.ts ❌ **REMOVE** (duplicate)
- [ ] conservative-ts2345-round2.ts ❌ **REMOVE** (duplicate)

### **Unused Variables Duplicates (10+ codemods - Keep prefix-unused-function-params)**
- [x] prefix-unused-function-params.ts ✅ **KEEP** (refactored to utility)
- [ ] fix-unused-vars-targeted.ts ❌ **REMOVE** (duplicate)
- [ ] fix-unused-vars-comprehensive.ts ❌ **REMOVE** (duplicate)
- [ ] fix-unused-vars-final.ts ❌ **REMOVE** (duplicate)
- [ ] fix-unused-vars-proven.ts ❌ **REMOVE** (duplicate)
- [ ] fix-unused-variables-simple.ts ❌ **REMOVE** (duplicate)
- [ ] fix-unused-variables-targeted.ts ❌ **REMOVE** (duplicate)
- [ ] fix-unused-variables-final.ts ❌ **REMOVE** (duplicate)
- [ ] fix-unused-simple.ts ❌ **REMOVE** (duplicate)
- [ ] focused-unused-param-fix.ts ❌ **REMOVE** (duplicate)
- [ ] smart-unused-vars-fix.ts ❌ **REMOVE** (duplicate)
- [ ] precision-unused-variables-cleanup.ts ❌ **REMOVE** (duplicate)
- [ ] unused-parameters-fix.ts ❌ **REMOVE** (duplicate)

### **Unused Imports Duplicates (5+ codemods - Keep unused-imports-cleanup)**
- [x] unused-imports-cleanup.ts ✅ **KEEP** (refactored to utility)
- [ ] fix-unused-imports.ts ❌ **REMOVE** (duplicate)
- [ ] remove-obvious-unused-imports.ts ❌ **REMOVE** (duplicate)
- [ ] remove-unused-imports.js ❌ **REMOVE** (JS duplicate)
- [ ] fix-remaining-import-issues.ts ❌ **REMOVE** (duplicate)
- [ ] remove-unused-imports.ts ❌ **EVALUATE** (large file, might have unique logic)

### **Variable Naming Duplicates (Keep fix-variable-naming-ast)**
- [x] fix-variable-naming-ast.ts ✅ **KEEP** (refactored to utility)
- [ ] fix-underscore-prefix.ts ❌ **REMOVE** (duplicate)
- [ ] fix-this-prefix.ts ❌ **REMOVE** (duplicate)

## **🎯 ONE-OFFS / TASK-SPECIFIC TO REMOVE**

### **Task/Context Specific**
- [ ] fix-tasks-test-unused-imports.ts ❌ **REMOVE** (task-specific)
- [ ] fix-session-ts-issues.ts ❌ **REMOVE** (session-specific)
- [ ] fix-test-parsing-issues.ts ❌ **REMOVE** (test-specific)

### **Repository Specific**
- [ ] fix-repository-naming-issues.ts ❌ **REMOVE** (specific)
- [ ] fix-repository-naming-issues-improved.ts ❌ **REMOVE** (improved version but still specific)
- [ ] fix-postgres-storage-types.ts ❌ **REMOVE** (postgres-specific)

### **Mocking Specific (7+ codemods - likely all one-offs)**
- [ ] fix-mocking-unknown-types.ts ❌ **REMOVE** (specific)
- [ ] fix-mocking-simple.ts ❌ **REMOVE** (specific)
- [ ] fix-mocking-unknown-ast.ts ❌ **REMOVE** (specific)
- [ ] fix-mocking-unknown-types-ast.ts ❌ **REMOVE** (specific)
- [ ] fix-mock-object-properties.ts ❌ **REMOVE** (specific)
- [ ] fix-mocking-comprehensive-ast.ts ❌ **REMOVE** (specific)
- [ ] fix-mocking-safe-ast.ts ❌ **REMOVE** (specific)
- [ ] fix-dependencies-mocks.ts ❌ **REMOVE** (specific)
- [ ] fix-mock-function-signatures.ts ❌ **REMOVE** (specific)

### **Bun Specific (likely one-offs)**
- [ ] fix-bun-compatibility-ast.ts ❌ **REMOVE** (bun-specific)
- [ ] fix-bun-process-types.ts ❌ **REMOVE** (bun-specific)
- [ ] fix-bun-types-ast.ts ❌ **REMOVE** (bun-specific)
- [ ] fix-bun-types-simple-ast.ts ❌ **REMOVE** (bun-specific)

### **Experimental/Aggressive (likely unsafe)**
- [ ] eliminate-ts2345-completely.ts ❌ **REMOVE** (aggressive)
- [ ] eliminate-ts2353-completely.ts ❌ **REMOVE** (aggressive)
- [ ] eliminate-ts2322-completely.ts ❌ **REMOVE** (aggressive)

### **Parsing/Syntax Specific**
- [ ] fix-specific-parsing-errors.ts ❌ **REMOVE** (specific)
- [ ] fix-remaining-parsing-errors.ts ❌ **REMOVE** (specific)
- [ ] fix-remaining-parsing.ts ❌ **REMOVE** (specific)
- [ ] fix-syntax-errors.ts ❌ **REMOVE** (generic/simple)
- [ ] fix-stray-commas.ts ❌ **REMOVE** (specific)

## **🤔 NEED EVALUATION**

### **Potentially Unique/Useful**
- [ ] remove-unused-imports.ts **EVALUATE** (14KB - might have unique logic)
- [ ] bulk-typescript-error-fixer.ts **EVALUATE** (9.9KB - might be comprehensive)
- [ ] fix-ts2339-property-not-exist.ts **KEEP** (unique TS error)
- [ ] fix-ts2353-object-literals.ts **KEEP** (unique TS error)
- [ ] fix-ts2552-name-resolution.ts **KEEP** (unique TS error)
- [ ] fix-ts2552-proper-resolution.ts **EVALUATE** (might be duplicate)
- [ ] fix-ts2564-property-initialization.ts **KEEP** (unique TS error)
- [ ] fix-ts2769-overload-mismatch.ts **KEEP** (unique TS error)
- [ ] fix-ts18046-unknown-types.ts **KEEP** (unique TS error)
- [ ] fix-ts18048-precise-patterns.ts **KEEP** (unique TS error)
- [ ] fix-ts18048-undefined-errors.ts **EVALUATE** (might be duplicate)

### **General Utilities**
- [ ] main-source-fixer.ts **EVALUATE** (might be useful)
- [ ] source-files-fixer.ts **EVALUATE** (might be duplicate)
- [ ] systematic-refactor-all.ts ❌ **REMOVE** (harmful script we already removed)

## **📊 ESTIMATED REDUCTION**
- **Current**: ~100 codemods
- **Remove Duplicates**: ~45 codemods
- **Remove One-offs**: ~20 codemods  
- **Remove Experimental**: ~5 codemods
- **After Cleanup**: ~30 codemods (70% reduction!)
- **After Utility Consolidation**: ~15-20 codemods (target) 
