/**
 * Test for Underscore Prefix Codemod
 * 
 * Tests the transformation logic to validate boundary violations discovered in analysis.
 */

import { test, expect } from 'bun:test';

// Extract the core transformation logic for testing
function fixUnderscorePrefix(content: string, fixes: { variable: string; line: number }[]): { content: string; changes: number } {
  const lines = content.split('\n');
  let totalFixed = 0;
  let modified = false;

  // Sort fixes by line number (descending) to avoid line number shifts
  fixes.sort((a, b) => b.line - a.line);

  for (const fix of fixes) {
    const lineIndex = fix.line - 1; // Convert to 0-based index
    if (lineIndex >= 0 && lineIndex < lines.length) {
      const line = lines[lineIndex];
      
      // Copy the exact patterns from the original codemod
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

  return { content: lines.join('\n'), changes: totalFixed };
}

test('fix-underscore-prefix: Critical failure - creates duplicate variable names', () => {
  const content = `
const result = someFunction();
const _result = anotherFunction();
return result + _result;
`;

  const fixes = [{ variable: 'result', line: 2 }];
  const { content: newContent } = fixUnderscorePrefix(content, fixes);

  // CRITICAL: This creates duplicate variable names
  expect(newContent).toContain('const _result = someFunction();');
  expect(newContent).toContain('const _result = anotherFunction();'); 
  // Now we have TWO variables named _result - compilation error!
});

test('fix-underscore-prefix: Critical failure - renames variables still being used', () => {
  const content = `
const data = fetchData();
processData(data);
const result = transform(data);
`;

  const fixes = [{ variable: 'data', line: 2 }];
  const { content: newContent } = fixUnderscorePrefix(content, fixes);

  // CRITICAL: Renames 'data' to '_data' but it's still used on lines 3 and 4
  expect(newContent).toContain('const _data = fetchData();');
  expect(newContent).toContain('processData(data);'); // ERROR: 'data' is not defined
  expect(newContent).toContain('const result = transform(data);'); // ERROR: 'data' is not defined
});

test('fix-underscore-prefix: Critical failure - destructuring context blindness', () => {
  const content = `
const { user, admin } = getPermissions();
const config = { user: 'default', admin: false };
`;

  const fixes = [{ variable: 'user', line: 2 }];
  const { content: newContent } = fixUnderscorePrefix(content, fixes);

  // CRITICAL: Pattern matching affects destructuring AND object properties
  expect(newContent).toContain('const { _user, admin } = getPermissions();');
  expect(newContent).toContain('const config = { _user: \'default\', admin: false };');
  // Now object property is incorrectly renamed
});

test('fix-underscore-prefix: Critical failure - function parameter scope collision', () => {
  const content = `
function process(data) {
  const _data = transform(data);
  return _data;
}
`;

  const fixes = [{ variable: 'data', line: 2 }];
  const { content: newContent } = fixUnderscorePrefix(content, fixes);

  // CRITICAL: Creates parameter _data that conflicts with existing variable _data
  expect(newContent).toContain('function process(_data) {');
  expect(newContent).toContain('const _data = transform(data);'); // ERROR: duplicate identifier
});

test('fix-underscore-prefix: Critical failure - ESLint dependency breaks robustness', () => {
  // This test documents that the codemod depends on ESLint output parsing
  // which makes it fragile and environment-dependent
  
  const eslintOutput = '  67:15  warning  \'result\' is assigned a value but never used. Allowed unused vars must match /^_+/u  no-unused-vars';
  
  // If ESLint config changes, this parsing breaks
  const match = eslintOutput.match(/^([^:]+):(\d+):\d+\s+warning\s+'([^']+)'/);
  
  // This approach is fundamentally unreliable
  expect(match).not.toBeNull();
  expect(match![3]).toBe('result');
}); 
