#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'fs';
import { globSync } from 'glob';

const files = globSync('src/**/*.ts', { ignore: ['**/*.d.ts'] });
console.log(`🔧 Processing ${files.length} TypeScript files to fix incorrect underscore prefixes...`);

let totalChanges = 0;
let modifiedFiles = 0;

for (const file of files) {
  const content = readFileSync(file, 'utf-8') as string;
  let newContent = content;
  let fileChanges = 0;

  // Fix common patterns where variables are used but incorrectly prefixed with underscore
  const fixes = [
    // Function calls and property access
    { regex: /\b_(\w+)\./g, replacement: '$1.' },
    { regex: /\b_(\w+)\(/g, replacement: '$1(' },
    { regex: /\b_(\w+)\[/g, replacement: '$1[' },
    
    // Variable assignments and comparisons
    { regex: /= _(\w+);/g, replacement: '= $1;' },
    { regex: /=== _(\w+)/g, replacement: '=== $1' },
    { regex: /!== _(\w+)/g, replacement: '!== $1' },
    { regex: /== _(\w+)/g, replacement: '== $1' },
    { regex: /!= _(\w+)/g, replacement: '!= $1' },
    
    // Return statements
    { regex: /return _(\w+);/g, replacement: 'return $1;' },
    { regex: /return _(\w+)\./g, replacement: 'return $1.' },
    { regex: /return _(\w+)\(/g, replacement: 'return $1(' },
    
    // Template literals and string interpolation
    { regex: /\${_(\w+)}/g, replacement: '${$1}' },
    
    // Array and object destructuring when used
    { regex: /\[_(\w+), /g, replacement: '[$1, ' },
    { regex: /, _(\w+)\]/g, replacement: ', $1]' },
    { regex: /\{_(\w+), /g, replacement: '{$1, ' },
    { regex: /, _(\w+)\}/g, replacement: ', $1}' },
    
    // Conditional expressions
    { regex: /_(\w+) \? /g, replacement: '$1 ? ' },
    { regex: /_(\w+) \|\| /g, replacement: '$1 || ' },
    { regex: /_(\w+) && /g, replacement: '$1 && ' },
    
    // Common method calls
    { regex: /\.push\(_(\w+)\)/g, replacement: '.push($1)' },
    { regex: /\.includes\(_(\w+)\)/g, replacement: '.includes($1)' },
    { regex: /\.map\(_(\w+)\)/g, replacement: '.map($1)' },
    { regex: /\.filter\(_(\w+)\)/g, replacement: '.filter($1)' },
    { regex: /\.forEach\(_(\w+)\)/g, replacement: '.forEach($1)' },
    
    // Property assignments
    { regex: /: _(\w+),/g, replacement: ': $1,' },
    { regex: /: _(\w+)\}/g, replacement: ': $1}' },
    { regex: /: _(\w+)$/g, replacement: ': $1' },
  ];

  // Apply fixes
  for (const fix of fixes) {
    const beforeReplace = newContent;
    newContent = newContent.replace(fix.regex, fix.replacement);
    const afterReplace = newContent;
    if (beforeReplace !== afterReplace) {
      const matches = (beforeReplace.match(fix.regex) || []).length;
      fileChanges += matches;
    }
  }

  // Write file if changes were made
  if (fileChanges > 0) {
    writeFileSync(file, newContent);
    console.log(`✅ Fixed ${fileChanges} incorrect underscore prefixes in ${file}`);
    modifiedFiles++;
    totalChanges += fileChanges;
  }
}

console.log(`\n🎯 Results:`);
console.log(`   Fixed: ${modifiedFiles} files`);
console.log(`   Total: ${files.length} files`);
console.log(`   Success rate: ${((modifiedFiles / files.length) * 100).toFixed(1)}%`);
console.log(`   Total changes: ${totalChanges}`); 
