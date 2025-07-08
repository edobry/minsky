import { VariableNamingCodemod, UnusedImportCodemod, UnusedVariableCodemod, TypeAssertionCodemod } from "../codemods/utils/specialized-codemods";

/**
 * Template for New Codemod Development
 * 
 * This template demonstrates how to use the specialized utility classes
 * for consistent, safe, and maintainable codemod development.
 * 
 * Choose the appropriate base class based on your transformation needs:
 * - VariableNamingCodemod: For variable naming fixes
 * - UnusedImportCodemod: For import cleanup
 * - UnusedVariableCodemod: For unused variable handling
 * - TypeAssertionCodemod: For type assertion fixes
 */

// Example 1: Variable Naming Fix
export class MyVariableNamingFix extends VariableNamingCodemod {
  constructor() {
    super();
    this.name = "MyVariableNamingFix";
    this.description = "Fixes specific variable naming issue X";
  }
  
  // Base class handles all standard functionality
  // Override specific methods only if needed for custom logic
}

// Example 2: Import Cleanup
export class MyImportCleanup extends UnusedImportCodemod {
  constructor() {
    super();
    this.name = "MyImportCleanup";
    this.description = "Removes unused imports for specific pattern Y";
  }
  
  // Base class provides comprehensive import analysis
  // Custom logic can be added by overriding specific methods
}

// Example 3: Unused Variable Handling
export class MyUnusedVariableCleanup extends UnusedVariableCodemod {
  constructor() {
    super();
    this.name = "MyUnusedVariableCleanup";
    this.description = "Handles unused variables in specific context Z";
  }
  
  // Base class provides safe variable handling
  // Custom scoping logic can be added as needed
}

// Example 4: Type Assertion Fix
export class MyTypeAssertionFix extends TypeAssertionCodemod {
  constructor() {
    super();
    this.name = "MyTypeAssertionFix";
    this.description = "Fixes type assertions for specific pattern W";
  }
  
  // Base class provides safe type assertion handling
  // Custom type analysis can be added by overriding methods
}

// Example 5: Custom Implementation (if needed)
export class MyCustomCodemod extends VariableNamingCodemod {
  constructor() {
    super();
    this.name = "MyCustomCodemod";
    this.description = "Custom implementation with specific requirements";
  }
  
  // Override applyToFile for custom logic while keeping safety checks
  applyToFile(filePath: string): boolean {
    return this.safeApplyChanges(filePath, (sourceFile) => {
      let hasChanges = false;
      
      // Your custom transformation logic here
      // Use sourceFile.getDescendantsOfKind() and other ts-morph methods
      
      // Example: Custom variable transformation
      sourceFile.getDescendantsOfKind(/* SyntaxKind.VariableDeclaration */).forEach(decl => {
        // Your custom logic
        // Remember to set hasChanges = true if modifications are made
      });
      
      return hasChanges;
    });
  }
}

/**
 * Usage Instructions:
 * 
 * 1. Choose the appropriate base class for your transformation type
 * 2. Inherit from the base class and provide name/description
 * 3. The base class handles all safety checks and error handling
 * 4. Override specific methods only if custom logic is needed
 * 5. Test thoroughly with various input scenarios
 * 
 * Benefits:
 * - Consistent safety checks and error handling
 * - Standardized interfaces and patterns
 * - Reduced code duplication
 * - Easier maintenance and updates
 * - Built-in AST-based transformations
 */

// Example usage in a script:
if (import.meta.main) {
  const codemod = new MyVariableNamingFix();
  const success = codemod.applyToFile("path/to/target/file.ts");
  console.log(`Transformation ${success ? "succeeded" : "failed"}`);
} 
