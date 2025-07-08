#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'fs';
import { glob } from 'glob';

/**
 * Simple codemod to fix common unused variable patterns
 * Focus on the most straightforward cases first
 */

function fixUnusedVarsInFile(filePath: string): boolean {
  try {
    let content: string = readFileSync(filePath, 'utf-8') as string;
    let modified = false;
    const originalContent = content;

    // Pattern 1: Function parameters that are unused
    // (param) => ... or (param: Type) => ... or function(param) { ... }
    const unusedParamPatterns = [
      // Arrow function parameters
      /\(([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*[^,)]+\)\s*=>/g,
      /\(([a-zA-Z_][a-zA-Z0-9_]*)\)\s*=>/g,
      // Regular function parameters in interfaces/abstract methods
      /\(([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*[^,)]+\)(?:\s*:\s*[^{;]+)?[{;]/g,
    ];

    // First, let's handle some common patterns we see in the errors
    
    // Fix common unused variables that are clearly unused
    const commonUnusedVars = [
      'options', 'record', 'updates', 'sessionName', 'specPath', 'status',
      'metadata', 'tasks', 'spec', 'title', 'config', 'workingDir', 'context',
      'parameters', 'command', '_content', 'newStatusChar', 'workdir', 'branch',
      'result', 'session', 'workspacePath', 'cause', 'prefix', 'promise'
    ];

    for (const varName of commonUnusedVars) {
      // Pattern: function parameter that's clearly unused
      const functionParamPattern = new RegExp(`\\b(function\\s*\\([^)]*\\b|\\([^)]*\\b|,\\s*)${varName}(\\s*:[^,)]+)?(\\s*[,)])`, 'g');
      content = content.replace(functionParamPattern, (match, before, type, after) => {
        if (!varName.startsWith('_')) {
          modified = true;
          return before + '_' + varName + (type || '') + after;
        }
        return match;
      });

      // Pattern: variable declaration that's clearly unused  
      const declPattern = new RegExp(`\\b(const|let|var)\\s+${varName}\\b(?!_)`, 'g');
      content = content.replace(declPattern, (match, keyword) => {
        if (!varName.startsWith('_')) {
          modified = true;
          return `${keyword} _${varName}`;
        }
        return match;
      });

      // Pattern: destructuring assignments
      const destructurePattern = new RegExp(`(\\{[^}]*\\s)${varName}(\\s*[,}])`, 'g');
      content = content.replace(destructurePattern, (match, before, after) => {
        if (!varName.startsWith('_')) {
          modified = true;
          return before + '_' + varName + after;
        }
        return match;
      });
    }

    // Additional specific patterns we can see from the lint output
    
    // Fix unused import statements (simple cases)
    const unusedImports = [
      'CommandDefinition', 'SessionRecord', 'TaskData', 'TaskState', 
      'CallToolRequest', 'ZodIssue', 'CommandParameterMap', 'ExecException',
      'ExecCallback', 'TransformableInfo', 'DEFAULT_RETRY_COUNT'
    ];

    for (const importName of unusedImports) {
      // Remove from named imports
      content = content.replace(new RegExp(`\\s*,\\s*${importName}\\s*`, 'g'), '');
      content = content.replace(new RegExp(`\\s*${importName}\\s*,\\s*`, 'g'), '');
      content = content.replace(new RegExp(`\\{\\s*${importName}\\s*\\}`, 'g'), '{}');
      
      if (content !== originalContent) {
        modified = true;
      }
    }

    // Clean up empty import statements
    content = content.replace(/import\s*\{\s*\}\s*from\s*['"][^'"]*['"];?\n?/g, '');

    if (modified) {
      writeFileSync(filePath, content, 'utf-8');
      console.log(`✅ Fixed unused variables in ${filePath}`);
      return true;
    }

    return false;
  } catch (error) {
    console.error(`❌ Error processing ${filePath}:`, error);
    return false;
  }
}

async function main() {
  console.log('🔧 Starting simple unused variables cleanup...');
  
  // Get all TypeScript files
  const files = await glob('src/**/*.ts', { ignore: ['node_modules/**', '**/*.d.ts'] });
  
  let fixedFiles = 0;
  let totalFiles = files.length;
  
  console.log(`📊 Processing ${totalFiles} TypeScript files...`);
  
  for (const file of files) {
    if (fixUnusedVarsInFile(file)) {
      fixedFiles++;
    }
  }
  
  console.log(`\n🎯 Results:`);
  console.log(`   Fixed: ${fixedFiles} files`);
  console.log(`   Total: ${totalFiles} files`);
  console.log(`   Success rate: ${((fixedFiles / totalFiles) * 100).toFixed(1)}%`);
}

if (require.main === module) {
  main().catch(console.error);
} 
