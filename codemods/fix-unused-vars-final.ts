#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'fs';
import { glob } from 'glob';

interface UnusedVarMatch {
  file: string;
  line: number;
  column: number;
  variable: string;
  type: 'no-unused-vars' | '@typescript-eslint/no-unused-vars';
}

function extractUnusedVars(): UnusedVarMatch[] {
  const { execSync } = require('child_process');
  const output = execSync('bun run lint 2>&1', { encoding: 'utf-8' });
  
  const matches: UnusedVarMatch[] = [];
  const lines = output.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Match no-unused-vars pattern
    const noUnusedMatch = line.match(/^\s*(\d+):(\d+)\s+warning\s+'([^']+)'\s+is defined but never used.*no-unused-vars$/);
    if (noUnusedMatch) {
      // Get the file from previous lines
      const fileLine = lines.slice(0, i).reverse().find(l => l.match(/^\/.*\.ts$/));
      if (fileLine) {
        matches.push({
          file: fileLine.trim(),
          line: parseInt(noUnusedMatch[1]),
          column: parseInt(noUnusedMatch[2]),
          variable: noUnusedMatch[3],
          type: 'no-unused-vars'
        });
      }
    }
    
    // Match @typescript-eslint/no-unused-vars pattern
    const typescriptMatch = line.match(/^\s*(\d+):(\d+)\s+warning\s+'([^']+)'\s+is defined but never used.*@typescript-eslint\/no-unused-vars$/);
    if (typescriptMatch) {
      // Get the file from previous lines
      const fileLine = lines.slice(0, i).reverse().find(l => l.match(/^\/.*\.ts$/));
      if (fileLine) {
        matches.push({
          file: fileLine.trim(),
          line: parseInt(typescriptMatch[1]),
          column: parseInt(typescriptMatch[2]),
          variable: typescriptMatch[3],
          type: '@typescript-eslint/no-unused-vars'
        });
      }
    }
  }
  
  return matches;
}

function fixUnusedVariable(content: string, variable: string, lineNumber: number): string {
  const lines = content.split('\n');
  if (lineNumber <= 0 || lineNumber > lines.length) return content;
  
  const line = lines[lineNumber - 1];
  
  // Skip if already prefixed with underscore
  if (variable.startsWith('_')) {
    return content;
  }
  
  // Patterns to match and replace
  const patterns = [
    // Function parameters: (variable, ...) or (variable: type, ...)
    new RegExp(`\\b${variable}\\b(?=\\s*[,:])`),
    // Variable declarations: const/let/var variable
    new RegExp(`(\\b(?:const|let|var)\\s+)${variable}\\b`),
    // Destructuring: { variable } or { variable: type }
    new RegExp(`(\\{\\s*[^}]*?)\\b${variable}\\b(?=\\s*[,}:])`),
    // Arrow function parameters: variable => or (variable) =>
    new RegExp(`\\b${variable}\\b(?=\\s*(?:,|\\)|=>))`),
    // For loop variables: for (let variable
    new RegExp(`(\\bfor\\s*\\(\\s*(?:let|const|var)\\s+)${variable}\\b`),
    // Catch blocks: catch (variable)
    new RegExp(`(\\bcatch\\s*\\(\\s*)${variable}\\b`),
    // Import statements: import { variable }
    new RegExp(`(\\bimport\\s*\\{[^}]*?)\\b${variable}\\b(?=\\s*[,}])`),
  ];
  
  let newLine = line;
  for (const pattern of patterns) {
    if (pattern.test(newLine)) {
      newLine = newLine.replace(pattern, (match, ...groups) => {
        if (groups.length > 0 && groups[0] !== undefined) {
          // Replace with group + _variable
          return groups[0] + '_' + variable;
        } else {
          // Replace variable with _variable
          return match.replace(new RegExp(`\\b${variable}\\b`), '_' + variable);
        }
      });
      break; // Only apply the first matching pattern
    }
  }
  
  lines[lineNumber - 1] = newLine;
  return lines.join('\n');
}

function processFile(filePath: string, variables: { variable: string, line: number }[]): boolean {
  try {
    let content = readFileSync(filePath, 'utf-8');
    let modified = false;
    
    // Sort by line number descending to avoid line number shifts
    variables.sort((a, b) => b.line - a.line);
    
    for (const { variable, line } of variables) {
      const originalContent = content;
      content = fixUnusedVariable(content, variable, line);
      if (content !== originalContent) {
        modified = true;
        console.log(`  Fixed unused variable '${variable}' at line ${line}`);
      }
    }
    
    if (modified) {
      writeFileSync(filePath, content, 'utf-8');
      return true;
    }
    
    return false;
  } catch (error) {
    console.error(`Error processing ${filePath}:`, error);
    return false;
  }
}

function main() {
  console.log('🔧 Extracting unused variables from lint output...');
  const unusedVars = extractUnusedVars();
  
  if (unusedVars.length === 0) {
    console.log('✅ No unused variables found!');
    return;
  }
  
  console.log(`📊 Found ${unusedVars.length} unused variables to fix`);
  
  // Group by file
  const fileGroups = new Map<string, { variable: string, line: number }[]>();
  for (const match of unusedVars) {
    if (!fileGroups.has(match.file)) {
      fileGroups.set(match.file, []);
    }
    fileGroups.get(match.file)!.push({
      variable: match.variable,
      line: match.line
    });
  }
  
  let totalFiles = 0;
  let totalFixed = 0;
  
  for (const [filePath, variables] of fileGroups) {
    console.log(`\n📁 Processing ${filePath}...`);
    console.log(`   Variables to fix: ${variables.map(v => v.variable).join(', ')}`);
    
    if (processFile(filePath, variables)) {
      totalFiles++;
      totalFixed += variables.length;
    }
  }
  
  console.log(`\n✅ Fixed ${totalFixed} unused variables in ${totalFiles} files`);
}

if (require.main === module) {
  main();
} 
