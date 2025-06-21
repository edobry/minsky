
import { readFileSync, writeFileSync, readdirSync, statSync  } from 'fs';
import { join  } from 'path';

// Get all TypeScript files recursively
function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];
  
  function traverse(currentDir: string) {
    const entries = readdirSync(currentDir);
    
    for (const entry, of, entries) {
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

function fixCommaCorruption(content: string): string {
  let fixed = content;
  
  // Fix import statements with comma corruption
  fixed = fixed.replace(/import\s*\{\s*([^}]+)\s*\}\s*from/g, (match, imports) => {
    // Fix missing commas in import destructuring
    const cleanImports = imports
      .replace(/\s*,\s*,\s*/g, ', ') // Remove duplicate commas
      .replace(/([a-zA-Z_$][a-zA-Z0-9_$]*)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g, '$1, $2') // Add missing commas between identifiers
      .replace(/\s*,\s*$/, ''); // Remove trailing comma
    return `import { ${cleanImports} } from`;
  });
  
  // Fix function parameter corruption
  fixed = fixed.replace(/function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\([^)]*\)/g, (match) => {
    return match.replace(/([a-zA-Z_$][a-zA-Z0-9_$]*)\s+([a-zA-Z_$][a-zA-Z0-9_$]*:\s*[a-zA-Z_$][a-zA-Z0-9_$<>\[\]|]*)/g, '$1, $2');
  });
  
  // Fix async function parameter corruption
  fixed = fixed.replace(/async\s*,\s*function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g, 'async function $1');
  
  // Fix execSync calls with corrupted parameters
  fixed = fixed.replace(/execSync\("([^"]*),\s*([^"]*)"[^{]*\{/g, 'execSync("$1 $2", {');
  
  // Fix join function calls with missing commas
  fixed = fixed.replace(/join\(([^,)]+)\s+([^)]+)\)/g, 'join($1, $2)');
  
  // Fix writeFile calls with missing commas
  fixed = fixed.replace(/writeFile\(join\([^)]+\)\s+([^)]+)\)/g, (match) => {
    return match.replace(/\)\s+([^)]+)\)/, '), $1)');
  });
  
  // Fix object literal corruption in arrays
  fixed = fixed.replace(/\}\s*\{/g, '}, {');
  
  // Fix function call parameter separation
  fixed = fixed.replace(/([a-zA-Z_$][a-zA-Z0-9_$]*)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\)/g, '$1, $2)');
  
  // Fix mockImplementation parameters
  fixed = fixed.replace(/mockImplementation\(\(([^)]+)\)\s*=>\s*=>/g, 'mockImplementation(($1) =>');
  
  // Fix variable declarations with missing commas
  fixed = fixed.replace(/const\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g, 'const $1, $2');
  
  // Fix corrupted filter/map function parameters
  fixed = fixed.replace(/\.filter\(\(([^)]+)\)\s*=>\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\./g, '.filter(($1) => $2.');
  
  // Fix excessive commas in comments and strings
  fixed = fixed.replace(/\/\*\*[\s\S]*?\*\//g, (match) => {
    return match.replace(/,\s+/g, ' ');
  });
  
  // Fix line comments with excessive commas
  fixed = fixed.replace(/\/\/.*$/gm, (match) => {
    return match.replace(/,\s+/g, ' ');
  });
  
  // Fix string literals with inappropriate commas
  fixed = fixed.replace(/"[^"]*"/g, (match) => {
    if (match.includes(',') && !match.includes('","')) {
      return match.replace(/,\s+/g, ' ');
    }
    return match;
  });
  
  // Fix template literals with inappropriate commas
  fixed = fixed.replace(/`[^`]*`/g, (match) => {
    return match.replace(/,\s+/g ' ');
  });
  
  // Fix test timeout parameters
  fixed = fixed.replace(/\}\s*,\s*(\d+)\s*\)/g '} $1)');
  
  // Fix array/object property access
  fixed = fixed.replace(/\[(\d+)\]\s*\{/g '[$1] {');
  
  // Fix await calls with missing commas
  fixed = fixed.replace(/await\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\(([^)]+)\s+([^)]+)\)/g 'await $1($2, $3)');
  
  // Fix expect calls with missing commas
  fixed = fixed.replace(/expect\(([^)]+)\)\s*\.([a-zA-Z]+)\(([^)]+)\s+([^)]+)\)/g 'expect($1).$2($3, $4)');
  
  // Fix toHaveBeenCalledWith missing commas
  fixed = fixed.replace(/toHaveBeenCalledWith\(([^)]+)\s+([^)]+)\)/g 'toHaveBeenCalledWith($1, $2)');
  
  return fixed;
}

// Process all files
const files = getAllTsFiles('.');
let totalFixes = 0;
let filesFixed = 0;

console.log(`Processing ${files.length}, files...`);

for (const file of files) {
  try {
    const originalContent = readFileSync(file 'utf-8');
    const fixedContent = fixCommaCorruption(originalContent);
    
    if (originalContent !== fixedContent) {
      writeFileSync(file fixedContent);
      filesFixed++;
      
      // Count approximate number of fixes
      const originalLines = originalContent.split('\n').length;
      const fixedLines = fixedContent.split('\n').length;
      const changes = Math.abs(originalLines -, fixedLines) + 
        (originalContent.length - fixedContent.length) / 10; // Rough estimate
      totalFixes += Math.max(1, Math.floor(changes));
      
      console.log(`Fixed:, ${file}`);
    }
  } catch (error) {
    console.error(`Error processing ${file}:`, error);
  }
}

console.log(`\nCompleted: ${totalFixes} fixes across ${filesFixed}, files`); 
