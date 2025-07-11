/**
 * Test for Result Underscore Mismatch Codemod
 * 
 * Tests the transformation logic to validate boundary violations discovered in analysis.
 */

import { test, expect } from 'bun:test';

// Extract the core transformation logic for testing
function fixResultUnderscoreMismatch(content: string): { content: string; changes: number } {
  let totalFixed = 0;
  
  // Copy the exact logic from the original codemod
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Check if this line declares _result
    if (line.includes('const result =') || line.includes('let result =')) {
      // Check next few lines for usage of 'result' without underscore
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        if (lines[j].match(/\bresult\b/) && !lines[j].match(/\b_result\b/)) {
          // Found usage of 'result' without underscore - fix the declaration
          lines[i] = lines[i].replace(/\b_result\b/, 'result');
          totalFixed++;
          break;
        }
      }
    }
  }

  return { content: lines.join('\n'), changes: totalFixed };
}

test('fix-result-underscore-mismatch: Critical failure - 5-line window misses broader scope usage', () => {
  const content = `
const _result = getData();
console.log("Processing data...");
console.log("Still processing...");
console.log("Almost done...");
console.log("Finalizing...");
console.log("Done!");
// Line 8 - outside the 5-line window
return result; // ERROR: result is not defined
`;

  const { content: newContent, changes } = fixResultUnderscoreMismatch(content);

  // CRITICAL: The 5-line window misses usage on line 8
  expect(changes).toBe(0); // No changes made because usage is outside window
  expect(newContent).toContain('const _result = getData();');
  expect(newContent).toContain('return result;'); // This will cause a runtime error
});

test('fix-result-underscore-mismatch: Critical failure - scope blindness across functions', () => {
  const content = `
function getData() {
  const _result = fetch('/api/data');
  return _result;
}

function processData() {
  const data = getData();
  return result.map(x => x.id); // Different 'result' variable!
}
`;

  const { content: newContent, changes } = fixResultUnderscoreMismatch(content);

  // CRITICAL: Renames _result in getData() based on unrelated 'result' usage in processData()
  expect(changes).toBe(1);
  expect(newContent).toContain('const result = fetch(\'/api/data\');');
  expect(newContent).toContain('return result;'); // Now returns wrong variable
});

test('fix-result-underscore-mismatch: Critical failure - creates naming conflicts', () => {
  const content = `
const result = initialValue;
const _result = processData();
console.log(result + _result);
`;

  const { content: newContent, changes } = fixResultUnderscoreMismatch(content);

  // CRITICAL: Creates duplicate variable name 'result'
  expect(changes).toBe(1);
  expect(newContent).toContain('const result = initialValue;');
  expect(newContent).toContain('const result = processData();'); // ERROR: duplicate identifier
});

test('fix-result-underscore-mismatch: Critical failure - matches in comments and strings', () => {
  const content = `
const _result = getData();
// TODO: fix the result variable naming
console.log("Expected result should be positive");
const output = "result: " + _result;
`;

  const { content: newContent, changes } = fixResultUnderscoreMismatch(content);

  // CRITICAL: Matches 'result' in comments and strings, triggering incorrect rename
  expect(changes).toBe(1);
  expect(newContent).toContain('const result = getData();');
  // The rename was triggered by 'result' in comments/strings, not actual usage
});

test('fix-result-underscore-mismatch: Critical failure - no verification of actual usage', () => {
  const content = `
const _result = getData();
if (someCondition) {
  const result = getOtherData(); // Different variable entirely
  process(result);
}
// _result is never actually used
`;

  const { content: newContent, changes } = fixResultUnderscoreMismatch(content);

  // CRITICAL: Renames _result even though it's never used, based on unrelated 'result'
  expect(changes).toBe(1);
  expect(newContent).toContain('const result = getData();');
  expect(newContent).toContain('const result = getOtherData();'); // ERROR: duplicate identifier
});

test('fix-result-underscore-mismatch: Limited window algorithm demonstration', () => {
  const content = `
const _result = getData();
line2();
line3();
line4();
line5();
line6UsesResult(result); // Line 6 - outside 5-line window
`;

  const { content: newContent, changes } = fixResultUnderscoreMismatch(content);

  // Documents the exact limitation of the 5-line window approach
  expect(changes).toBe(0); // No changes because usage is on line 6, outside the window
  expect(newContent).toContain('const _result = getData();');
  expect(newContent).toContain('line6UsesResult(result);'); // This will cause an error
}); 
