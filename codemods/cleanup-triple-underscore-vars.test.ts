/**
 * Test for Triple-Underscore Variable Cleanup Codemod
 * 
 * Validates the codemod does ONLY what it claims:
 * - Only removes variables that start with triple-underscore prefix (___variableName)
 * - Handles standalone declarations, catch blocks, and destructuring
 * - Ignores single/double underscore variables and normal variables
 * - Cleans up excessive empty lines
 */

import { test, expect } from 'bun:test';

// Extract the core transformation logic for testing
function cleanupTripleUnderscoreVars(content: string): { content: string; changes: number } {
  let newContent = content;
  let fileChanges = 0;

  const fixes = [
    // 1. Remove standalone triple-underscore variable declarations
    {
      pattern: /^\s*const\s+___\w+\s*[=:][^;]*[;]?\s*$/gm,
      replacement: "",
      description: "Remove triple-underscore variable declarations"
    },
    
    // 2. Convert catch blocks with triple-underscore variables to parameterless
    {
      pattern: /catch\s*\(\s*___\w+\s*\)\s*\{/g,
      replacement: "catch {",
      description: "Convert catch blocks to parameterless"
    },
    
    // 3. Remove triple-underscore variables from destructuring
    {
      pattern: /,\s*___\w+\s*(?=[,}])/g,
      replacement: "",
      description: "Remove triple-underscore from destructuring"
    },
    
    // 4. Clean up empty lines left by removals
    {
      pattern: /\n\s*\n\s*\n/g,
      replacement: "\n\n",
      description: "Clean up excessive empty lines"
    }
  ];

  for (const fix of fixes) {
    const matches = newContent.match(fix.pattern);
    if (matches) {
      const beforeReplace = newContent;
      newContent = newContent.replace(fix.pattern, fix.replacement);
      if (newContent !== beforeReplace) {
        fileChanges += matches.length;
      }
    }
  }

  return { content: newContent, changes: fileChanges };
}

test('Triple-underscore cleanup removes ONLY triple-underscore variables', () => {
  const input = `
const ___unused = someValue;
const __doubleUnderscore = keepThis;
const _singleUnderscore = keepThis;
const normalVariable = keepThis;
const ___anotherUnused = anotherValue;
const regularCode = "should stay";
`;

  const { content: result, changes } = cleanupTripleUnderscoreVars(input);
  
  // Should remove triple-underscore variables
  expect(result).not.toContain('___unused');
  expect(result).not.toContain('___anotherUnused');
  
  // Should keep single/double underscore variables
  expect(result).toContain('__doubleUnderscore');
  expect(result).toContain('_singleUnderscore');
  expect(result).toContain('normalVariable');
  expect(result).toContain('regularCode');
  
  // Should report correct number of changes
  expect(changes).toBe(2);
});

test('Triple-underscore cleanup converts catch blocks correctly', () => {
  const input = `
try {
  riskyOperation();
} catch (___error) {
  // handle error
}

try {
  anotherOperation();
} catch (normalError) {
  // should keep this parameter
}

try {
  thirdOperation();
} catch (___ignored) {
  // remove this parameter
}
`;

  const { content: result, changes } = cleanupTripleUnderscoreVars(input);
  
  // Should convert triple-underscore catch blocks to parameterless
  expect(result).toContain('} catch {');
  expect(result).not.toContain('___error');
  expect(result).not.toContain('___ignored');
  
  // Should keep normal catch blocks unchanged
  expect(result).toContain('catch (normalError)');
  
  // Should report correct number of changes
  expect(changes).toBe(2);
});

test('Triple-underscore cleanup removes from destructuring correctly', () => {
  const input = `
const { value, ___unused, important } = obj;
const { first, ___ignored, second, ___alsoIgnored } = data;
const { keepThis, normalVar } = config;
const { onlyTriple, ___remove } = settings;
`;

  const { content: result, changes } = cleanupTripleUnderscoreVars(input);
  
  // Should remove triple-underscore variables from destructuring
  expect(result).not.toContain('___unused');
  expect(result).not.toContain('___ignored');
  expect(result).not.toContain('___alsoIgnored');
  expect(result).not.toContain('___remove');
  
  // Should keep normal variables
  expect(result).toContain('value');
  expect(result).toContain('important');
  expect(result).toContain('first');
  expect(result).toContain('second');
  expect(result).toContain('keepThis');
  expect(result).toContain('normalVar');
  expect(result).toContain('onlyTriple');
  
  // Should report correct number of changes
  expect(changes).toBe(4);
});

test('Triple-underscore cleanup cleans up excessive empty lines', () => {
  const input = `
const ___removed = value;



const keepThis = value;




const ___alsoRemoved = another;
`;

  const { content: result, changes } = cleanupTripleUnderscoreVars(input);
  
  // Should clean up excessive empty lines
  expect(result).not.toContain('\n\n\n\n');
  expect(result).toContain('keepThis');
  
  // Should have made changes for removals and line cleanup
  expect(changes).toBeGreaterThan(0);
});

test('Triple-underscore cleanup ignores non-triple-underscore patterns', () => {
  const input = `
const _normalUnderscore = "keep";
const __doubleUnderscore = "keep";
const regular = "keep";
function ___functionName() {} // should not be removed
class ___ClassName {} // should not be removed
`;

  const { content: result, changes } = cleanupTripleUnderscoreVars(input);
  
  // Should keep single/double underscore variables
  expect(result).toContain('_normalUnderscore');
  expect(result).toContain('__doubleUnderscore');
  expect(result).toContain('regular');
  
  // Should keep function and class names (not variable declarations)
  expect(result).toContain('function ___functionName');
  expect(result).toContain('class ___ClassName');
  
  // Should make no changes since no triple-underscore variables to remove
  expect(changes).toBe(0);
});

test('Triple-underscore cleanup reveals regex limitation with quadruple underscores', () => {
  // This test documents a limitation: the regex ___\w+ matches variables that START with ___
  // This means ____quadrupleUnderscore gets matched because it starts with ___
  const input = `
const ____quadrupleUnderscore = "actually gets removed";
const ___exactlyTriple = "gets removed as expected";
`;

  const { content: result, changes } = cleanupTripleUnderscoreVars(input);
  
  // LIMITATION: Quadruple underscore variables are also removed because regex matches ___\w+
  expect(result).not.toContain('____quadrupleUnderscore');
  expect(result).not.toContain('___exactlyTriple');
  
  // Should report changes for both variables
  expect(changes).toBe(2);
});

test('Triple-underscore cleanup handles edge cases safely', () => {
  const input = `
// Edge case: triple-underscore in strings should be ignored
const message = "This ___should not be removed";
const regex = /___pattern/g;

// Edge case: triple-underscore in comments should be ignored
// const ___commentedOut = value;

// Edge case: mixed patterns
const { valid, ___remove, ___alsoRemove, keep } = data;
`;

  const { content: result, changes } = cleanupTripleUnderscoreVars(input);
  
  // Should ignore triple-underscore in strings and comments
  expect(result).toContain('"This ___should not be removed"');
  expect(result).toContain('/___pattern/g');
  expect(result).toContain('// const ___commentedOut = value;');
  
  // Should remove from destructuring
  expect(result).not.toContain('___remove');
  expect(result).not.toContain('___alsoRemove');
  expect(result).toContain('valid');
  expect(result).toContain('keep');
  
  // Should report correct number of changes
  expect(changes).toBe(2);
}); 
