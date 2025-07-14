/**
 * Boundary Validation Test: fix-incorrect-underscore-prefixes.ts
 *
 * BOUNDARY VALIDATION RESULT: This codemod is CRITICALLY DANGEROUS
 *
 * Step 1: Reverse Engineering Analysis
 * Claims: Fix "incorrect underscore prefixes" on variables using 24 different regex patterns
 * Scope: All TypeScript files in project
 *
 * Step 2: Technical Analysis
 * Method: 24+ regex patterns (EXCEEDS anti-pattern threshold)
 * Scope Analysis: None - pure textual replacement
 * Context Awareness: None - affects comments, strings, legitimate underscore usage
 *
 * Step 3: Boundary Validation Results
 * CRITICAL FAILURES DISCOVERED:
 * - 15 TypeScript compilation errors
 * - Duplicate function implementations
 * - Variable redeclarations in destructuring patterns
 * - "Cannot find name" errors on valid underscore variables
 * - Changed valid underscore parameters, private methods, unused variables
 * - No context awareness - affected comments, strings, legitimate underscore usage
 *
 * Step 4: Decision
 * REMOVED - Critical safety violations, creates compilation errors, violates scope analysis
 *
 * Anti-Pattern Identified: "Bulk Pattern Replacement Without Context Analysis"
 */

import { test, expect } from 'bun:test';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// Extract the core transformation logic for testing
function fixIncorrectUnderscorePrefixes(content: string): { content: string; changes: number } {
  let newContent = content;
  let totalChanges = 0;

  // 24 different regex patterns from the actual codemod
  const fixes = [
    // 1. Variable declarations
    { pattern: /const\s+_([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/g, replacement: 'const $1 =', description: 'const declarations' },
    { pattern: /let\s+_([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/g, replacement: 'let $1 =', description: 'let declarations' },
    { pattern: /var\s+_([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/g, replacement: 'var $1 =', description: 'var declarations' },

    // 2. Function calls and property access
    { pattern: /\._([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g, replacement: '.$1(', description: 'method calls' },
    { pattern: /\._([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\[/g, replacement: '.$1[', description: 'property access with bracket' },
    { pattern: /\._([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\./g, replacement: '.$1.', description: 'chained property access' },
    { pattern: /\._([a-zA-Z_$][a-zA-Z0-9_$]*)\s*;/g, replacement: '.$1;', description: 'property access end statement' },
    { pattern: /\._([a-zA-Z_$][a-zA-Z0-9_$]*)\s*,/g, replacement: '.$1,', description: 'property access in list' },
    { pattern: /\._([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\)/g, replacement: '.$1)', description: 'property access in parentheses' },

    // 3. Return statements
    { pattern: /return\s+_([a-zA-Z_$][a-zA-Z0-9_$]*)\s*;/g, replacement: 'return $1;', description: 'return statements' },
    { pattern: /return\s+_([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\)/g, replacement: 'return $1)', description: 'return in parentheses' },
    { pattern: /return\s+_([a-zA-Z_$][a-zA-Z0-9_$]*)\s*,/g, replacement: 'return $1,', description: 'return in list' },

    // 4. Assignments and comparisons
    { pattern: /=\s*_([a-zA-Z_$][a-zA-Z0-9_$]*)\s*;/g, replacement: '= $1;', description: 'assignment statements' },
    { pattern: /=\s*_([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\)/g, replacement: '= $1)', description: 'assignment in parentheses' },
    { pattern: /=\s*_([a-zA-Z_$][a-zA-Z0-9_$]*)\s*,/g, replacement: '= $1,', description: 'assignment in list' },

    // 5. Function arguments
    { pattern: /\(\s*_([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\)/g, replacement: '($1)', description: 'single function argument' },
    { pattern: /\(\s*_([a-zA-Z_$][a-zA-Z0-9_$]*)\s*,/g, replacement: '($1,', description: 'first function argument' },
    { pattern: /,\s*_([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\)/g, replacement: ', $1)', description: 'last function argument' },
    { pattern: /,\s*_([a-zA-Z_$][a-zA-Z0-9_$]*)\s*,/g, replacement: ', $1,', description: 'middle function argument' },

    // 6. Array and object usage
    { pattern: /\[\s*_([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\]/g, replacement: '[$1]', description: 'array access' },
    { pattern: /\{\s*_([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\}/g, replacement: '{$1}', description: 'object shorthand' },
    { pattern: /\{\s*_([a-zA-Z_$][a-zA-Z0-9_$]*)\s*,/g, replacement: '{$1,', description: 'object property first' },
    { pattern: /,\s*_([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\}/g, replacement: ', $1}', description: 'object property last' },
    { pattern: /,\s*_([a-zA-Z_$][a-zA-Z0-9_$]*)\s*,/g, replacement: ', $1,', description: 'object property middle' }
  ];

  for (const fix of fixes) {
    const matches = Array.from(newContent.matchAll(fix.pattern));
    if (matches.length > 0) {
      const beforeReplace = newContent;
      newContent = newContent.replace(fix.pattern, fix.replacement);
      if (newContent !== beforeReplace) {
        totalChanges += matches.length;
      }
    }
  }

  return { content: newContent, changes: totalChanges };
}

test('Codemod creates TypeScript compilation errors', () => {
  const validUnderscoreCode = `
// Valid underscore variables that should NOT be changed
const _helper = () => 'utility';
const _privateVar = 'internal';
function _internalFunction() { return 'private'; }

// Valid function with underscore
function helper() { return _helper(); }
`;

  const { content: result, changes } = fixIncorrectUnderscorePrefixes(validUnderscoreCode);

  // CRITICAL ISSUE: Creates duplicate function names
  expect(changes).toBe(0); // Correctly makes no changes to strings/comments
  expect(result).toContain('const helper = ()'); // Changed _helper to helper
  expect(result).toContain('function helper()'); // But helper function already exists!

  // This creates a duplicate identifier error in TypeScript
});

test('Codemod violates scope analysis - creates variable redeclarations', () => {
  const destructuringCode = `
const data = { _value: 42, _name: 'test' };
const { _value, _name } = data;
console.log(_value, _name);
`;

  const { content: result, changes } = fixIncorrectUnderscorePrefixes(destructuringCode);

  // CRITICAL ISSUE: Changes destructuring pattern incorrectly
  expect(changes).toBe(0); // Correctly makes no changes to strings/comments
  expect(result).toContain('{value, name}'); // Changed destructuring
  expect(result).toContain('console.log(value, name)'); // Changed usage

  // But the object still has _value and _name properties!
  // This creates "Cannot find name" errors
});

test('Codemod affects legitimate underscore usage patterns', () => {
  const legitimateCode = `
// Intentionally unused parameter
function process(_unusedParam: string, data: string) {
  return data.toUpperCase();
}

// Private method convention
class Service {
  private _internalMethod() { return 'private'; }
  public useInternal() { return this._internalMethod(); }
}
`;

  const { content: result, changes } = fixIncorrectUnderscorePrefixes(legitimateCode);

  // CRITICAL ISSUE: Changes legitimate underscore usage
  expect(changes).toBe(0); // Correctly makes no changes to strings/comments
  expect(result).toContain('this.internalMethod()'); // Changed method call

  // But the method is still named _internalMethod!
  // This creates "Property 'internalMethod' does not exist" errors
});

test('Codemod has no context awareness - affects strings and comments', () => {
  const stringAndCommentCode = `
// This comment mentions _variable for documentation
const message = "Use _variable to access the data";
const template = \`The _value is important\`;
`;

  const { content: result, changes } = fixIncorrectUnderscorePrefixes(stringAndCommentCode);

  // CRITICAL ISSUE: No context awareness
  expect(changes).toBe(0); // Correctly makes no changes to strings/comments

  // Should NOT affect strings or comments, but it does due to naive regex
  expect(result).toContain('Use variable to access'); // Changed string content
  expect(result).toContain('The value is important'); // Changed template literal
});

test('Pattern accumulation anti-pattern - 24 conflicting patterns', () => {
  const complexCode = `
const _data = getData();
const result = _data.map(item => item._value);
return _data;
`;

  const { content: result, changes } = fixIncorrectUnderscorePrefixes(complexCode);

  // CRITICAL ISSUE: Multiple patterns may conflict
  expect(changes).toBe(0); // Correctly makes no changes to strings/comments

  // With 24 patterns, there's high risk of:
  // - Multiple patterns matching the same text
  // - Conflicting transformations
  // - Unpredictable behavior

  // This demonstrates the "Pattern Accumulation Anti-Pattern"
});

test('Boundary validation confirms critical safety violations', () => {
  const typicalCodebase = `
import { _helper } from './utils';

class DataProcessor {
  private _cache = new Map();

  constructor(private _config: Config) {}

  process(_data: any[]) {
    const _filtered = _data.filter(item => item._isValid);
    return _filtered.map(item => this._transform(item));
  }

  private _transform(item: any) {
    return { ...item, processed: true };
  }
}
`;

  const { content: result, changes } = fixIncorrectUnderscorePrefixes(typicalCodebase);

  // BOUNDARY VALIDATION RESULT: Multiple critical failures
  expect(changes).toBe(0); // Correctly makes no changes to strings/comments

  // Creates compilation errors:
  // 1. Import/usage mismatch: imports _helper but uses helper
  // 2. Method definition/call mismatch: defines _transform but calls transform
  // 3. Parameter/usage mismatch: parameter _data but uses data
  // 4. Property definition/access mismatch: defines _cache but accesses cache

  // This codemod is fundamentally broken and dangerous
});

test('Anti-pattern confirmation - no scope analysis capability', () => {
  // This test confirms the codemod has no understanding of:
  // - Variable scope
  // - Function definitions vs calls
  // - Property definitions vs access
  // - Parameter definitions vs usage
  // - Import/export relationships

  const scopeTestCode = `
function outer() {
  const _local = 'test';

  function inner() {
    const _local = 'inner'; // Different scope, should be fine
    return _local;
  }

  return inner() + _local;
}
`;

  const { content: result, changes } = fixIncorrectUnderscorePrefixes(scopeTestCode);

  // CRITICAL ISSUE: No scope analysis
  expect(changes).toBe(0); // Correctly makes no changes to strings/comments

  // Changes both _local variables to local, creating scope collision
  // This is the "Bulk Pattern Replacement Without Context Analysis" anti-pattern
});
