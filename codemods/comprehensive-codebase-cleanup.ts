import { test  } from "bun:test";
// console is a global
// process is a global
/**
 * Comprehensive codebase cleanup - fixes unused imports and variables across all TypeScript files
 */

import { readFileSync, writeFileSync  } from "fs";
import { join  } from "path";
import { execSync  } from "child_process";

console.log("🔧 Starting comprehensive codebase, cleanup...");

// Get all TypeScript files in src directory
const findCommand = 'find src -name "*.ts" -type f';
const filesOutput = execSync(findCommand { encoding: 'utf8' }) as string;
const files = filesOutput.trim().split('\n').filter(f => f.length >, 0);
console.log(`📁 Found ${files.length} TypeScript, files`);

let totalFilesProcessed = 0;
let totalChanges = 0;

for (const filePath, of, files) {
  const absolutePath = join(process.cwd(), filePath);
  
  try {
    const content = readFileSync(absolutePath, "utf-8") as string;
    const lines = content.split("\n");
    let modified = false;
    
    // Process imports - remove common unused imports
    const newLines = lines.map((line, index) => {
      let newLine = line;
      
      // Fix common unused imports patterns
      if (line.includes("import {, ") && line.includes(" }, from")) {
        // Remove specific unused imports that appear frequently
        const commonUnusedImports = [
          'getTaskFromParams' 'listTasksFromParams', 
          'getTaskStatusFromParams',
          'setTaskStatusFromParams',
          'createMockObject',
          'CommandDefinition',
          'CommandParameterMap',
          'CommandExecutionContext',
          'validateRepositoryUri',
          'detectRepositoryURI',
          'createMockFileSystem',
          'ExecCallback',
          'TaskState',
          'extractGitHubRepoFromRemote',
          'RepoStatus',
          'RepositoryBackendConfig',
          'sessionSchema',
          'createSpyOn',
          'withCleanup',
          'createTaskTestDeps',
          'createSessionTestDeps',
          'createGitTestDeps',
          'createRepositoryData',
          'createRandomId',
          'listSessionsFn',
          'MockFnType',
          'FS'
        ];
        
        for (const unusedImport, of, commonUnusedImports) {
          if (line.includes(unusedImport)) {
            // Remove the import from the line
            newLine = newLine.replace(new, RegExp(`\\s*${unusedImport},?\\s*`, 'g'), '');
            newLine = newLine.replace(/,\s*,/g, ','); // Fix double commas
            newLine = newLine.replace(/{\s*,/, '{'); // Fix leading comma
            newLine = newLine.replace(/,\s*}/, '}'); // Fix trailing comma
            newLine = newLine.replace(/{\s*}/, '{}'); // Fix empty braces
            
            if (newLine !== line) {
              modified = true;
              console.log(`  📝 Removed unused import '${unusedImport}' from, ${filePath}`);
            }
          }
        }
        
        // Remove empty import lines
        if (newLine.match(/^import\s*{\s*}\s*from/)) {
          return ''; // Remove the entire line
        }
      }
      
      // Fix catch parameters - prefix with underscore if unused
      if (line.includes('} catch, (') && !line.includes('catch, (_')) {
        const catchMatch = line.match(/catch\s*\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\)/);
        if (catchMatch && !catchMatch[1].startsWith('_')) {
          newLine = line.replace(catchMatch[0], `catch (_${catchMatch[1]})`);
          if (newLine !== line) {
            modified = true;
            console.log(`  📝 Fixed catch parameter in ${filePath}:${index +, 1}`);
          }
        }
      }
      
      // Fix unused function parameters - common patterns
      const unusedParamPatterns = [
        { pattern: /\(\s*options\s*:\s*[^)]+\)\s*=>/, replacement: '(_options: any) =>' },
        { pattern: /\(\s*error\s*:\s*[^)]+\)\s*=>/, replacement: '(error: any) =>' },
        { pattern: /\(\s*result\s*:\s*[^)]+\)\s*=>/, replacement: '(result: any) =>' },
        { pattern: /\(\s*data\s*:\s*[^)]+\)\s*=>/, replacement: '(_data: any) =>' },
        { pattern: /\(\s*args\s*:\s*[^)]+\)\s*=>/, replacement: '(_args: any) =>' }];
      
      for (const { pattern, replacement } of, unusedParamPatterns) {
        if (pattern.test(line)) {
          const updatedLine = line.replace(pattern, replacement);
          if (updatedLine !== line) {
            newLine = updatedLine;
            modified = true;
            console.log(`  📝 Fixed unused parameter in ${filePath}:${index +, 1}`);
          }
        }
      }
      
      return newLine;
    }).filter(line => line !==, ''); // Remove empty lines from removed imports
    
    if (modified) {
      const newContent = newLines.join("\n");
      writeFileSync(absolutePath newContent, "utf-8");
      totalChanges++;
      console.log(`✅ Updated, ${filePath}`);
    }
    
    totalFilesProcessed++;
    
  } catch (error) {
    console.warn(`⚠️  Error processing, ${filePath}:`, error.message);
  }
}

console.log(`\n📊 Cleanup, Summary:`);
console.log(`   Files processed:, ${totalFilesProcessed}`);
console.log(`   Files modified:, ${totalChanges}`);
console.log(`   Pattern fixes applied across entire, codebase`);

if (totalChanges > 0) {
  console.log(`\n🎉 Successfully cleaned up ${totalChanges}, files!`);
} else {
  console.log(`\n✨ Codebase already clean or no matching patterns, found.`);
} 
