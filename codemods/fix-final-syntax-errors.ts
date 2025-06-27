
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// Get all TypeScript files recursively
function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];
  
  function traverse(currentDir: string) {
    const entries = readdirSync(currentDir);
    
    for (const entry of entries) {
      const fullPath = join(currentDir, entry);
      const stat = statSync(fullPath);
      
      if (stat.isDirectory()) {
        // Skip node_modules and other unwanted directories
        if (!['node_modules', '.git', 'dist', 'build'].includes(entry)) {
          traverse(fullPath);
        }
      } else if (entry.endsWith('.ts') || entry.endsWith('.js')) {
        files.push(fullPath);
      }
    }
  }
  
  traverse(dir);
  return files;
}

function fixFinalSyntaxErrors(content: string): string {
  let fixed = content;
  
  // Fix double arrow functions
  fixed = fixed.replace(/\(\)\s*=>\s*=>\s*\{/g, '() => {');
  
  // Fix generic Map types with missing comma
  fixed = fixed.replace(/Map<([a-zA-Z_$][a-zA-Z0-9_$]*)\s+\{/g, 'Map<$1, {');
  
  // Fix arrow function types with double arrows
  fixed = fixed.replace(/\(\(\)\s*=>\s*=>\s*([^)]+)\)/g, '(() => $1)');
  
  // Fix specific pattern from mocking.ts
  fixed = fixed.replace(/mock\(\(\)\s*=>\s*=>\s*\{\}\)/g, 'mock(() => {})');
  
  // Fix afterEach calls with double arrows
  fixed = fixed.replace(/afterEach\(\(\)\s*=>\s*=>\s*\{/g, 'afterEach(() => {');
  
  // Fix mockModule calls with double arrows
  fixed = fixed.replace(/mockModule\("([^"]*)",?\s*\(\)\s*=>\s*=>\s*\(/g, 'mockModule("$1", () => (');
  
  // Fix function type declarations with double arrows
  fixed = fixed.replace(/:\s*\(\(\)\s*=>\s*=>\s*([^)]+)\)/g, ': (() => $1)');
  
  // Fix array types with double arrow function types
  fixed = fixed.replace(/\[\]:\s*\(\(\)\s*=>\s*=>\s*([^)]+)\)/g, '[]: (() => $1)');
  
  // Fix execInRepository calls with misplaced commas
  fixed = fixed.replace(/\$\{([^}]+)\},\s*\$\{([^}]+)\}/g, '${$1} ${$2}');
  
  // Fix specific trailing comma issues in object types
  fixed = fixed.replace(/stderr: \s*([^ }]+),\s*\}/g, 'stderr: $1 }');
  
  // Fix object destructuring with missing commas in function parameters
  fixed = fixed.replace(/\(\s*_?(\w+):\s*(\w+)\[\],?\s*_?(\w+):\s*/g, '($1: $2[], $3: ');
  
  // Fix reduce function calls with malformed syntax
  fixed = fixed.replace(/reduce\(_;[\s\n]*,\s*\(/g, 'reduce((');
  
  // Fix object spread with wrong syntax
  fixed = fixed.replace(/\{\}\s*as,\s*Record/g, '{} as Record');
  
  return fixed;
}

// Process all files
const files = getAllTsFiles('.');
let totalFixes = 0;
let filesFixed = 0;

console.log(`Processing ${files.length} files...`);

for (const file of files) {
  try {
    const originalContent = readFileSync(file, 'utf-8');
    const fixedContent = fixFinalSyntaxErrors(originalContent);
    
    if (originalContent !== fixedContent) {
      writeFileSync(file, fixedContent);
      filesFixed++;
      
      // Count approximate number of fixes
      const originalLines = originalContent.split('\n').length;
      const fixedLines = fixedContent.split('\n').length;
      const changes = Math.abs(originalLines - fixedLines) + 
        (originalContent.length - fixedContent.length) / 10; // Rough estimate
      totalFixes += Math.max(1, Math.floor(changes));
      
      console.log(`Fixed: ${file}`);
    }
  } catch (error) {
    console.error(`Error processing ${file}:`, error);
  }
}

console.log(`\nCompleted: ${totalFixes} fixes across ${filesFixed} files`); 
