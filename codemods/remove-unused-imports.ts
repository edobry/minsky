/**
 * TypeScript codemod to remove unused imports and variables
 * Uses ts-morph for better TypeScript support
 */

import { Project, SourceFile, ImportDeclaration, VariableDeclaration } from "ts-morph";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

export async function removeUnusedImports(filePath: string): Promise<boolean> {
  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
  });

  // Add the file to the project
  const sourceFile = project.addSourceFileAtPath(filePath);
  
  let modificationsMode = false;

  // Get all import declarations
  const imports = sourceFile.getImportDeclarations();
  
  for (const importDeclaration of imports) {
    const importClause = importDeclaration.getImportClause();
    if (!importClause) continue;

    // Handle named imports
    const namedBindings = importClause.getNamedBindings();
    if (namedBindings && namedBindings.getKind() === 276) { // NamedImports
      const namedImports = namedBindings.asKindOrThrow(276);
      const elements = namedImports.getElements();
      
      const usedElements = elements.filter(element => {
        const name = element.getName();
        // Check if this identifier is used anywhere in the file
        const identifiers = sourceFile.getDescendantsOfKind(79); // Identifier
        return identifiers.some(id => 
          id.getText() === name && 
          id !== element.getNameNode() && 
          !isInImportDeclaration(id)
        );
      });

      if (usedElements.length === 0) {
        // Remove the entire import if no named imports are used
        importDeclaration.remove();
        modificationsMode = true;
      } else if (usedElements.length < elements.length) {
        // Remove only unused named imports
        const unusedElements = elements.filter(e => !usedElements.includes(e));
        unusedElements.forEach(e => e.remove());
        modificationsMode = true;
      }
    }

    // Handle default imports
    const defaultImport = importClause.getDefaultImport();
    if (defaultImport) {
      const name = defaultImport.getText();
      const identifiers = sourceFile.getDescendantsOfKind(79); // Identifier
      const isUsed = identifiers.some(id => 
        id.getText() === name && 
        id !== defaultImport &&
        !isInImportDeclaration(id)
      );
      
      if (!isUsed) {
        // If there are no named imports either, remove the whole declaration
        if (!namedBindings) {
          importDeclaration.remove();
          modificationsMode = true;
        } else {
          defaultImport.remove();
          modificationsMode = true;
        }
      }
    }
  }

  // Handle unused variable declarations
  const variableStatements = sourceFile.getVariableStatements();
  
  for (const variableStatement of variableStatements) {
    const declarations = variableStatement.getDeclarations();
    
    const usedDeclarations = declarations.filter(declaration => {
      const name = declaration.getName();
      if (typeof name !== "string") return true; // Keep complex patterns
      
      // Check if this variable is used anywhere
      const identifiers = sourceFile.getDescendantsOfKind(79); // Identifier
      return identifiers.some(id => 
        id.getText() === name && 
        id !== declaration.getNameNode() &&
        !isInVariableDeclaration(id)
      );
    });

    if (usedDeclarations.length === 0) {
      // Remove the entire variable statement
      variableStatement.remove();
      modificationsMode = true;
    } else if (usedDeclarations.length < declarations.length) {
      // Remove unused declarations
      const unusedDeclarations = declarations.filter(d => !usedDeclarations.includes(d));
      unusedDeclarations.forEach(d => d.remove());
      modificationsMode = true;
    }
  }

  if (modificationsMode) {
    // Save the file
    await sourceFile.save();
    return true;
  }

  return false;
}

function isInImportDeclaration(node: any): boolean {
  let parent = node.getParent();
  while (parent) {
    if (parent.getKind() === 260) return true; // ImportDeclaration
    parent = parent.getParent();
  }
  return false;
}

function isInVariableDeclaration(node: any): boolean {
  let parent = node.getParent();
  while (parent) {
    if (parent.getKind() === 249) return true; // VariableDeclaration
    parent = parent.getParent();
  }
  return false;
}

// CLI usage
if (import.meta.main) {
  const filePaths = process.argv.slice(2);
  
  if (filePaths.length === 0) {
    console.log("Usage: bun run codemods/remove-unused-imports.ts <file1> <file2> ...");
    process.exit(1);
  }

  for (const filePath of filePaths) {
    console.log(`Processing ${filePath}...`);
    try {
      const modified = await removeUnusedImports(filePath);
      if (modified) {
        console.log(`✅ Cleaned up unused imports in ${filePath}`);
      } else {
        console.log(`ℹ️  No changes needed in ${filePath}`);
      }
    } catch (error) {
      console.error(`❌ Error processing ${filePath}:`, error);
    }
  }
} 
