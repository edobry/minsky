#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";

// Get the specific variables that need underscore prefixes
const eslintOutput = execSync('bun eslint . 2>&1 | grep "Allowed unused vars must match"', { encoding: "utf8" }).toString();
const lines = eslintOutput.split('\n').filter(line => line.trim());

const fixes: { file: string; line: number; variable: string }[] = [];

// Parse each ESLint warning
for (const line of lines) {
  // Example: "  67:15  warning  'result' is assigned a value but never used. Allowed unused vars must match /^_+/u  no-unused-vars"
  const match = line.match(/^([^:]+):(\d+):\d+\s+warning\s+'([^']+)'/);
  if (match) {
    const [, filePath, lineNum, variable] = match;
    // Remove leading path prefix to get relative path
    const relativePath = filePath.replace(/^.*\/sessions\/136\//, './');
    fixes.push({
      file: relativePath,
      line: parseInt(lineNum),
      variable: variable
    });
  }
}

console.log(`Found ${fixes.length} variables to prefix with underscore`);

// Group fixes by file
const fileGroups = fixes.reduce((acc, fix) => {
  if (!acc[fix.file]) acc[fix.file] = [];
  acc[fix.file].push(fix);
  return acc;
}, {} as Record<string, typeof fixes>);

let totalFixed = 0;
const fixedFiles: string[] = [];

// Process each file
for (const [filePath, fileFixes] of Object.entries(fileGroups)) {
  try {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    let modified = false;

    // Sort fixes by line number (descending) to avoid line number shifts
    fileFixes.sort((a, b) => b.line - a.line);

    for (const fix of fileFixes) {
      const lineIndex = fix.line - 1; // Convert to 0-based index
      if (lineIndex >= 0 && lineIndex < lines.length) {
        const line = lines[lineIndex];
        
        // Simple pattern replacements for common cases
        const patterns = [
          { from: `const ${fix.variable} =`, to: `const _${fix.variable} =` },
          { from: `let ${fix.variable} =`, to: `let _${fix.variable} =` },
          { from: `var ${fix.variable} =`, to: `var _${fix.variable} =` },
          { from: `${fix.variable}:`, to: `_${fix.variable}:` }, // destructuring
          { from: `(${fix.variable})`, to: `(_${fix.variable})` }, // function parameters
          { from: `(${fix.variable},`, to: `(_${fix.variable},` }, // function parameters
          { from: `, ${fix.variable})`, to: `, _${fix.variable})` }, // function parameters
          { from: `, ${fix.variable},`, to: `, _${fix.variable},` }, // function parameters
        ];

        for (const pattern of patterns) {
          if (line.includes(pattern.from)) {
            lines[lineIndex] = line.replace(pattern.from, pattern.to);
            modified = true;
            totalFixed++;
            break;
          }
        }
      }
    }

    if (modified) {
      writeFileSync(filePath, lines.join('\n'));
      fixedFiles.push(filePath);
    }
  } catch (error) {
    console.error(`Error processing ${filePath}:`, error);
  }
}

console.log(`\nFixed ${totalFixed} variables in ${fixedFiles.length} files`);
if (fixedFiles.length > 0) {
  console.log('\nFixed files:');
  fixedFiles.forEach(f => console.log(`  ${f}`));
} 
