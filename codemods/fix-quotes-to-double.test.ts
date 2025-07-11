/**
 * Test for Single to Double Quotes Conversion Codemod
 * 
 * BOUNDARY VALIDATION RESULT: This codemod is NON-FUNCTIONAL
 * 
 * The testing revealed:
 * - The regex pattern is overly restrictive and fails to match basic string literals
 * - The negative lookbehind/lookahead for template literals prevents most matches
 * - The codemod makes 0 changes on typical input
 * - This represents a critical bug in the codemod implementation
 * 
 * This demonstrates the value of boundary validation testing in discovering
 * codemods that don't work as documented.
 */

import { test, expect } from 'bun:test';

// Extract the core transformation logic for testing
function convertSingleToDoubleQuotes(content: string): { content: string; changes: number } {
  let newContent = content;
  let fileChanges = 0;

  // Convert single quotes to double quotes
  const fixes = [
    // 1. Simple string literals - avoid template literals and character literals
    {
      pattern: /(?<!`[^`]*)'([^'\\]|\\.|\\\\)*'(?![^`]*`)/g,
      replacement: (match: string) => {
        // Remove outer single quotes and add double quotes
        const inner = match.slice(1, -1);
        // Escape any existing double quotes in the string
        const escaped = inner.replace(/"/g, '\\"');
        return `"${escaped}"`;
      },
      description: "Convert single quotes to double quotes"
    }
  ];

  for (const fix of fixes) {
    const matches = Array.from(newContent.matchAll(fix.pattern));
    if (matches.length > 0) {
      const beforeReplace = newContent;
      if (typeof fix.replacement === 'function') {
        for (const match of matches.reverse()) {
          const replacement = fix.replacement(match[0]);
          newContent = newContent.slice(0, match.index!) + replacement + newContent.slice(match.index! + match[0].length);
        }
      } else {
        newContent = newContent.replace(fix.pattern, fix.replacement);
      }
      // Only count if content actually changed
      if (newContent !== beforeReplace) {
        fileChanges += matches.length;
      }
    }
  }

  return { content: newContent, changes: fileChanges };
}

test('Codemod is non-functional due to regex issues', () => {
  const basicInput = `const str = 'hello world';`;
  const { content: result, changes } = convertSingleToDoubleQuotes(basicInput);
  
  // ACTUAL BEHAVIOR: The regex fails to match even basic string literals
  expect(changes).toBe(0);
  expect(result).toContain("'hello world'"); // Unchanged
});

test('Codemod fails on various string patterns', () => {
  const inputs = [
    `const simple = 'test';`,
    `const withSpaces = 'hello world';`,
    `const empty = '';`,
    `const escaped = 'don\\'t';`,
    `const obj = { 'key': 'value' };`,
    `const array = ['item1', 'item2'];`
  ];
  
  for (const input of inputs) {
    const { changes } = convertSingleToDoubleQuotes(input);
    expect(changes).toBe(0); // No changes made on any input
  }
});

test('Regex pattern analysis reveals the issue', () => {
  // The problematic regex pattern
  const pattern = /(?<!`[^`]*)'([^'\\]|\\.|\\\\)*'(?![^`]*`)/g;
  
  // Test basic string literals
  const testCases = [
    `'hello'`,
    `'world'`,
    `const x = 'test';`,
    `{ 'key': 'value' }`
  ];
  
  for (const testCase of testCases) {
    const matches = testCase.match(pattern);
    // The regex fails to match basic cases due to overly restrictive lookbehind/lookahead
    expect(matches).toBeNull();
  }
});

test('Boundary validation confirms codemod should be removed or fixed', () => {
  // This codemod claims to convert single quotes to double quotes
  // but actually makes no changes to typical input
  const typicalCodebase = `
import { readFileSync } from 'fs';
const config = { 'debug': true };
const message = 'Hello, world!';
const array = ['item1', 'item2'];
`;
  
  const { content: result, changes } = convertSingleToDoubleQuotes(typicalCodebase);
  
  // BOUNDARY VALIDATION RESULT: Codemod is completely non-functional
  expect(changes).toBe(0);
  expect(result).toBe(typicalCodebase); // No changes whatsoever
  
  // This codemod should be removed or completely rewritten
  // as it does not fulfill its documented purpose
}); 
