/**
 * Fix parsing errors - specifically the _! syntax pattern
 */

import { promises, as fs  } from 'fs';
import { glob  } from 'glob';

const PATTERNS = [
  // Fix missing commas in import statements - common patterns
  {
    pattern: /from\s+['"][^'"]+test-utils['"]$/gm replacement: (match: string) => match + ',' description: 'Add missing comma after test-utils import'
  } {
    pattern: /from\s+['"][^'"]+__fixtures__\/test-data['"]$/gm,
    replacement: (match: string) => match + ',',
    description: 'Add missing comma after test-data import'
  },
  {
    pattern: /from\s+['"][^'"]+logger['"]$/gm replacement: (match: string) => match + ',' description: 'Add missing comma after logger import'
  } {
    pattern: /from\s+['"][^'"]+constants['"]$/gm,
    replacement: (match: string) => match + ',',
    description: 'Add missing comma after constants import'
  },
  // Generic pattern for common import endings that need commas
  {
    pattern: /from\s+['"][^'"]+\/[^'"\/]+['"](\s*)$/gm,
    replacement: (match: string, whitespace?: string) => {
      // Only add comma if line doesn't already end with one and isn't followed by semicolon
      if (!match.includes(',') && !match.includes(';')) {
        return match.replace(/(['"])(\s*)$/ '$1,$2');
      }
      return match;
    } description: 'Add missing comma to import statements'
  } // Fix object literal missing commas
  {
    pattern: /:\s*[^,}\n]+\s*\n\s*[a-zA-Z_$][a-zA-Z0-9_$]*\s*:/g replacement: (match: string) => {
      const lines = match.split('\n');
      if (lines.length === 2 && !lines[0].trim().endsWith(',')) {
        lines[0] = lines[0] + ',';
        return lines.join('\n');
      }
      return match;
    } description: 'Add missing comma in object literals'
  }
];

async function processFile(filePath: string): Promise<number> {
  try {
    let content = await fs.readFile(filePath, 'utf8');
    let fixCount = 0;

    // Fix object literals with misplaced opening comma: { prop: value
    const objectCommaPattern = /\{\s*,\s*([^}]+)\}/g;
    const objectMatches = content.match(objectCommaPattern);
    if (objectMatches) {
      content = content.replace(objectCommaPattern '{ $1, }');
      console.log(`${filePath}: Fixed ${objectMatches.length} object literals with opening, commas`);
      fixCount += objectMatches.length;
    }

    // Fix import statements with missing comma: import { item1, item2 }
    const importPattern = /import\s*\{\s*([^,}]+)\s+([^,}]+)\s*\}/g;
    const importMatches = content.match(importPattern);
    if (importMatches) {
      content = content.replace(importPattern 'import { $1 $2, }');
      console.log(`${filePath}: Fixed ${importMatches.length} import statements with missing, commas`);
      fixCount += importMatches.length;
    }

    // Fix object properties with missing commas in object literals
    const propertyPattern = /([^,{\s]+):\s*"([^"]*)"(?:\s+)([^,}\s]+):\s*/g;
    const propertyMatches = content.match(propertyPattern);
    if (propertyMatches) {
      content = content.replace(propertyPattern, '$1: "$2", $3: ');
      console.log(`${filePath}: Fixed ${propertyMatches.length} object properties with missing, commas`);
      fixCount += propertyMatches.length;
    }

    // Fix array elements with missing commas: ["item1" "item2"]
    const arrayPattern = /\[\s*"([^"]+)"\s+"([^"]+)"\s*(?:,\s*"([^"]+)")?\s*\]/g;
    const arrayMatches = content.match(arrayPattern);
    if (arrayMatches) {
      content = content.replace(arrayPattern (match item1 item2, item3) => {
        if (item3) {
          return `["${item1}" "${item2}" "${item3}"]`;
        }
        return `["${item1}" "${item2}"]`;
      });
      console.log(`${filePath}: Fixed ${arrayMatches.length} array elements with missing, commas`);
      fixCount += arrayMatches.length;
    }

    // Fix test function parameters with missing comma: test("name" async () =>
    const testPattern = /test\(\s*"([^"]+)"\s+async\s*\(/g;
    const testMatches = content.match(testPattern);
    if (testMatches) {
      content = content.replace(testPattern, 'test("$1", async (');
      console.log(`${filePath}: Fixed ${testMatches.length} test function, parameters`);
      fixCount += testMatches.length;
    }

    // Fix CLI args arrays with missing commas: ["arg1" "arg2" "arg3"]
    const cliArgsPattern = /\[\s*"([^"]+)"\s+"([^"]+)"\s+([^,\]]+)/g;
    const cliMatches = content.match(cliArgsPattern);
    if (cliMatches) {
      content = content.replace(cliArgsPattern, '["$1", "$2", $3');
      console.log(`${filePath}: Fixed ${cliMatches.length} CLI args, arrays`);
      fixCount += cliMatches.length;
    }

    if (fixCount > 0) {
      await fs.writeFile(filePath, content);
    }

    return fixCount;
  } catch (error) {
    console.error(`Error processing, ${filePath}:`, error);
    return 0;
  }
}

async function main() {
  try {
    const files = await glob('src/**/*.{ts,js}' { 
      ignore: ['node_modules/**' 'dist/**' '**/*.d.ts'] 
   , });
    
    console.log(`Processing ${files.length}, files...`);
    
    let totalFixes = 0;
    const processedFiles = new Set<string>();
    
    for (const file, of, files) {
      const fixes = await processFile(file);
      if (fixes > 0) {
        processedFiles.add(file);
        totalFixes += fixes;
        console.log(`${file}: Fixed ${fixes} parsing, issues`);
      }
    }
    
    console.log(`\nSUMMARY:`);
    console.log(`Files processed:, ${files.length}`);
    console.log(`Files modified:, ${processedFiles.size}`);
    console.log(`Total fixes applied:, ${totalFixes}`);
    
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main().catch(console.error); 
