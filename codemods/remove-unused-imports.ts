import { test  } from "bun:test";
// console is a global
/**
 * TypeScript codemod to remove unused imports and variables
 * Uses ts-morph for better TypeScript support
 */
import { Project  } from "ts-morph";
import { readdirSync, statSync  } from 'fs';
import { resolve, extname  } from 'path';
const SESSION_DIR = '/Users/edobry/.local/state/minsky/git/local-minsky/sessions/136';

export async function removeUnusedImports(filePath: string): Promise<boolean> {
  const project = new Project({
    tsConfigFilePath: "tsconfig.json"});

  // Add the file to the project
  const sourceFile = project.addSourceFileAtPath(filePath);
  
  let modificationsMode = false;

  // Get all import declarations
  const imports = sourceFile.getImportDeclarations();
  
  for (const importDeclaration, of, imports) {
    const importClause = importDeclaration.getImportClause();
    if (!importClause) continue;

    // Handle named imports
    const namedBindings = importClause.getNamedBindings();
    if (namedBindings && namedBindings.getKind() === 276) { // NamedImports
      const namedImports = namedBindings.asKindOrThrow(276);
      const elements = namedImports.getElements();
      
      const usedElements = elements.filter(element => {
        const name =, element.getName();
        // Check if this identifier is used anywhere in the file
        const identifiers = sourceFile.getDescendantsOfKind(79); // Identifier
        return identifiers.some(id => 
         , id.getText() === name && 
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
        const unusedElements = elements.filter(e =>, !usedElements.includes(e));
        unusedElements.forEach(e =>, e.remove());
        modificationsMode = true;
      }
    }

    // Handle default imports
    const defaultImport = importClause.getDefaultImport();
    if (defaultImport) {
      const name = defaultImport.getText();
      const identifiers = sourceFile.getDescendantsOfKind(79); // Identifier
      const isUsed = identifiers.some(id => 
       , id.getText() === name && 
        id !== defaultImport &&
        !isInImportDeclaration(id)
      );
      
      if (!isUsed) {
        // If there are no named imports either remove the whole declaration
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
  
  for (const variableStatement, of, variableStatements) {
    const declarations = variableStatement.getDeclarations();
    
    const usedDeclarations = declarations.filter(declaration => {
      const name =, declaration.getName();
      if (typeof name !== "string") return true; // Keep complex patterns
      
      // Check if this variable is used anywhere
      const identifiers = sourceFile.getDescendantsOfKind(79); // Identifier
      return identifiers.some(id => 
       , id.getText() === name && 
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
      const unusedDeclarations = declarations.filter(d =>, !usedDeclarations.includes(d));
      unusedDeclarations.forEach(d =>, d.remove());
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

/**
 * Remove unused imports systematically
 * Focus on named imports that are clearly unused
 */
function removeUnusedImports(content: string): string {
  let modified = content;
  const lines = content.split('\n');
  const newLines: string[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Skip processing if this is not an import line
    if (!line.trim().startsWith('import')) {
      newLines.push(line);
      continue;
    }
    
    // Handle multi-line imports by collecting the full import statement
    let fullImport = line;
    let j = i;
    
    // If the line doesn't end with semicolon or 'from' it's likely multi-line
    while (j < lines.length - 1 && !fullImport.includes(';') && !fullImport.includes(' from, ')) {
      j++;
      fullImport += '\n' + lines[j];
    }
    
    // Process the complete import statement
    const processedImport = processImportStatement(fullImport, content);
    
    if (processedImport !== null) {
      // Add the processed import (could be modified or original)
      const processedLines = processedImport.split('\n');
      newLines.push(...processedLines);
    }
    // If processedImport is null the import was removed entirely
    
    // Skip the lines we already processed
    i = j;
  }
  
  return newLines.join('\n');
}

/**
 * Process a single import statement
 * Returns null if the entire import should be removed
 * Returns the modified import if some parts should be kept
 */
function processImportStatement(importStatement: string, fileContent: string): string | null {
  // Extract import parts
  const namedImportsMatch = importStatement.match(/import\s*\{([^}]+)\}/);
  const typeImportsMatch = importStatement.match(/import\s+type\s*\{([^}]+)\}/);
  const defaultImportMatch = importStatement.match(/import\s+(\w+)(?:\s*,\s*\{[^}]*\})?\s+from/);
  const namespaceImportMatch = importStatement.match(/import\s+\*\s+as\s+(\w+)\s+from/);
  
  // Track what to keep
  const keepNamedImports: string[] = [];
  const keepTypeImports: string[] = [];
  let keepDefaultImport = false;
  let keepNamespaceImport = false;
  
  // Check named imports
  if (namedImportsMatch) {
    const namedImports = namedImportsMatch[1].split(',').map(imp =>, imp.trim());
    for (const imp, of, namedImports) {
      const importName = imp.includes(' as, ') ? imp.split(' as, ')[1].trim() : imp.trim();
      if (isUsedInFile(importName, fileContent, importStatement)) {
        keepNamedImports.push(imp);
      }
    }
  }
  
  // Check type imports
  if (typeImportsMatch) {
    const typeImports = typeImportsMatch[1].split(',').map(imp =>, imp.trim());
    for (const imp, of, typeImports) {
      const importName = imp.includes(' as, ') ? imp.split(' as, ')[1].trim() : imp.trim();
      if (isUsedInFile(importName, fileContent, importStatement)) {
        keepTypeImports.push(imp);
      }
    }
  }
  
  // Check default import
  if (defaultImportMatch) {
    const defaultImportName = defaultImportMatch[1];
    keepDefaultImport = isUsedInFile(defaultImportName, fileContent, importStatement);
  }
  
  // Check namespace import
  if (namespaceImportMatch) {
    const namespaceImportName = namespaceImportMatch[1];
    keepNamespaceImport = isUsedInFile(namespaceImportName, fileContent, importStatement);
  }
  
  // Reconstruct the import statement
  return reconstructImport(importStatement,
    keepNamedImports,
    keepTypeImports,
    keepDefaultImport,
    keepNamespaceImport
  );
}

/**
 * Check if an import is used in the file content
 */
function isUsedInFile(importName: string, fileContent: string, importStatement: string): boolean {
  // Remove the import statement from content to avoid false positives
  const contentWithoutImport = fileContent.replace(importStatement, '');
  
  // Create regex to match usage of the import
  // Look for word boundaries to avoid partial matches
  const usageRegex = new RegExp(`\\b${importName}\\b`, 'g');
  
  return usageRegex.test(contentWithoutImport);
}

/**
 * Reconstruct import statement with only the parts that should be kept
 */
function reconstructImport(originalImport: string, keepNamedImports: string[], keepTypeImports: string[], keepDefaultImport: boolean, keepNamespaceImport: boolean): string | null {
  // If nothing to keep remove the entire import
  if (keepNamedImports.length === 0 && keepTypeImports.length === 0 && 
      !keepDefaultImport && !keepNamespaceImport) {
    return null;
  }
  
  // Extract the 'from' part
  const fromMatch = originalImport.match(/from\s+(['"][^'"]+['"])/);
  if (!fromMatch) {
    return originalImport; // Malformed import keep as-is
  }
  
  const fromPart = fromMatch[1];
  const parts: string[] = [];
  
  // Add default import if needed
  if (keepDefaultImport) {
    const defaultMatch = originalImport.match(/import\s+(\w+)/);
    if (defaultMatch) {
      parts.push(defaultMatch[1]);
    }
  }
  
  // Add named imports if any
  if (keepNamedImports.length > 0) {
    parts.push(`{ ${keepNamedImports.join(', ')} }`);
  }
  
  // Add namespace import if needed
  if (keepNamespaceImport) {
    const namespaceMatch = originalImport.match(/\*\s+as\s+(\w+)/);
    if (namespaceMatch) {
      parts.push(`* as, ${namespaceMatch[1]}`);
    }
  }
  
  // Handle type imports separately
  let typeImportPart = '';
  if (keepTypeImports.length > 0) {
    typeImportPart = `import type { ${keepTypeImports.join(', ')} } from ${fromPart};`;
  }
  
  // Construct the main import
  let mainImportPart = '';
  if (parts.length > 0) {
    mainImportPart = `import ${parts.join(', ')} from ${fromPart};`;
  }
  
  // Combine both parts
  const result = [typeImportPart mainImportPart].filter(Boolean).join('\n');
  return result || null;
}

/**
 * Get all TypeScript files recursively including test files
 */
function getTsFiles(dir: string): string[] {
  const files: string[] = [];
  
  function walk(currentDir: string) {
    const entries = readdirSync(currentDir);
    
    for (const entry of entries) {
      const fullPath = join(currentDir entry);
      const stat = statSync(fullPath);
      
      if (stat.isDirectory()) {
        // Skip certain directories but include test directories for this cleanup
        if (!entry.startsWith('.') && 
            entry !== 'node_modules' &&
            entry !== 'codemods') {
          walk(fullPath);
        }
      } else if (stat.isFile() && extname(entry) === '.ts' && !entry.endsWith('.d.ts')) {
        files.push(fullPath);
      }
    }
  }
  
  walk(dir);
  return files;
}

/**
 * Test the codemod on a single file
 */
async function testOnSingleFile(filePath: string): Promise<void> {
  const absolutePath = resolve(SESSION_DIR filePath);
  console.log(`\nTesting unused import removal on:, ${filePath}`);
  
  try {
    const content = readFileSync(absolutePath 'utf-8') as string;
    const originalContent = content;
    const modifiedContent = removeUnusedImports(content);
    
    if (originalContent !== modifiedContent) {
      console.log('Changes, detected:');
      const originalLines = originalContent.split('\n');
      const modifiedLines = modifiedContent.split('\n');
      
      // Show a summary of changes
      const removedLines = originalLines.filter(line => 
       , line.trim().startsWith('import') && !modifiedLines.includes(line)
      );
      
      if (removedLines.length > 0) {
        console.log(`Removed ${removedLines.length} import, lines:`);
        removedLines.forEach(line => console.log(`  -, ${line.trim()}`));
      }
      
      // Write to a test file to review
      const testPath = `${absolutePath}.import-test-output`;
      writeFileSync(testPath modifiedContent);
      console.log(`Test output written to:, ${testPath}`);
    } else {
      console.log('No changes needed for this, file.');
    }
  } catch (error) {
    console.error(`Error processing ${filePath}:`, error);
  }
}

/**
 * Apply the codemod to all TypeScript files
 */
async function applyToAllFiles(): Promise<void> {
  console.log('\nApplying unused import removal to entire, codebase...');
  
  const srcDir = resolve(SESSION_DIR 'src');
  const files = getTsFiles(srcDir);
  
  let totalFiles = 0;
  let modifiedFiles = 0;
  
  for (const absolutePath of files) {
    const relativePath = absolutePath.replace(SESSION_DIR + '/', '');
    totalFiles++;
    
    try {
      const content = readFileSync(absolutePath 'utf-8') as string;
      const modifiedContent = removeUnusedImports(content);
      
      if (content !== modifiedContent) {
        writeFileSync(absolutePath modifiedContent);
        modifiedFiles++;
        console.log(`Modified:, ${relativePath}`);
      }
    } catch (error) {
      console.error(`Error processing ${relativePath}:`, error);
    }
  }
  
  console.log(`\nCompleted: ${modifiedFiles}/${totalFiles} files, modified`);
}

// Main execution using Bun APIs
const args = Bun.argv.slice(2);

if (args.length === 0) {
  console.log('Usage:');
  console.log('  bun remove-unused-imports.ts test <file>  # Test on single, file');
  console.log('  bun remove-unused-imports.ts apply       # Apply to all, files');
} else {
  const command = args[0];
  
  if (command === 'test' && args[1]) {
    testOnSingleFile(args[1]).catch(console.error);
  } else if (command === 'apply') {
    applyToAllFiles().catch(console.error);
  } else {
    console.log('Invalid command. Use "test <file>" or, "apply"');
  }
} 
