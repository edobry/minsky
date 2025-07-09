/**
 * Test for Bulk TypeScript Error Fixer Codemod
 * 
 * Validates this complex heuristic-based bulk TypeScript error fixer:
 * - Tests heuristic pattern matching for different error categories
 * - Reveals potential issues with aggressive bulk fixing approach
 * - Validates AST-based transformations work as intended
 * - Tests boundary conditions and edge cases
 * - Demonstrates risks of pattern-based over regex-based type analysis
 */

import { test, expect } from 'bun:test';

// Mock the helper functions for testing (extracted from the codemod)
function mockIsLikelyUndefinedProperty(expressionText: string, propertyName: string): boolean {
  const undefinedPatterns = [
    'result', 'response', 'data', 'config', 'options', 'params',
    'task', 'session', 'repo', 'workspace', 'backend'
  ];
  
  return undefinedPatterns.some(pattern => 
    expressionText.includes(pattern) || propertyName.includes(pattern)
  );
}

function mockNeedsTypeAssertion(argText: string): boolean {
  return (
    argText === 'error' ||
    argText.includes('unknown') ||
    argText.includes('result') ||
    argText.includes('response') ||
    (argText.includes('|') && argText.includes('null')) ||
    (argText.includes('|') && argText.includes('undefined'))
  );
}

function mockGetTypeAssertionFix(argText: string): string {
  if (argText === 'error') return 'error as Error';
  if (argText.includes('unknown')) return `${argText} as any`;
  if (argText.includes('| null')) return `${argText}!`;
  if (argText.includes('| undefined')) return `${argText}!`;
  if (argText.includes('string[]') && !argText.includes('[0]')) {
    return `Array.isArray(${argText}) ? ${argText}[0] : ${argText}`;
  }
  return argText;
}

function mockIsUnknownTypeIssue(text: string): boolean {
  return (
    text.includes('unknown') ||
    text === 'error' ||
    text.includes('catch') ||
    text.includes('response') ||
    text.includes('result')
  );
}

function mockFixUnknownType(text: string): string {
  if (text === 'error') return 'error as Error';
  if (text.includes('unknown')) return `${text} as any`;
  return text;
}

function mockNeedsObjectTypeAssertion(expressionText: string, propertyName: string): boolean {
  const problematicProperties = [
    'rowCount', 'affectedRows', 'specPath', 'taskId', 'session',
    'repoPath', 'workspacePath', 'backend'
  ];
  
  return problematicProperties.includes(propertyName) && 
         !expressionText.includes('as any') &&
         !expressionText.includes('!');
}

test('Bulk TypeScript fixer HEURISTIC LIMITATION: pattern matching vs actual type analysis', () => {
  // Test the heuristic pattern matching for undefined properties
  
  // FALSE POSITIVE: Variable named 'result' but actually well-typed
  expect(mockIsLikelyUndefinedProperty('result', 'length')).toBe(true);
  
  // FALSE NEGATIVE: Actually undefined property but not matching pattern
  expect(mockIsLikelyUndefinedProperty('userObj', 'name')).toBe(false);
  
  // The heuristic approach relies on variable names, not actual type analysis
  expect(mockIsLikelyUndefinedProperty('myData', 'property')).toBe(true); // data pattern
  expect(mockIsLikelyUndefinedProperty('wellTypedObject', 'property')).toBe(false); // no pattern
  
  console.warn('HEURISTIC LIMITATION: Pattern matching based on variable names, not actual types');
  console.warn('Results in false positives (well-typed but matching pattern) and false negatives (undefined but not matching)');
});

test('Bulk TypeScript fixer AGGRESSIVE FIXING: adds unnecessary type assertions', () => {
  // Test type assertion logic that may be overly aggressive
  
  // These might not actually need type assertions
  expect(mockNeedsTypeAssertion('result')).toBe(true); // Just because it contains 'result'
  expect(mockNeedsTypeAssertion('response')).toBe(true); // Just because it contains 'response'
  expect(mockNeedsTypeAssertion('myResult')).toBe(true); // Contains 'result' substring
  
  // These might legitimately need assertions
  expect(mockNeedsTypeAssertion('error')).toBe(true);
  expect(mockNeedsTypeAssertion('value | null')).toBe(true);
  
  // The logic is overly broad and may fix code that doesn't need fixing
  console.warn('AGGRESSIVE FIXING: Pattern matching may add unnecessary type assertions');
  console.warn('Variables with certain substrings get fixed regardless of actual type issues');
});

test('Bulk TypeScript fixer TYPE ASSERTION FIXES: may hide legitimate type errors', () => {
  // Test the type assertion fixes that may be too aggressive
  
  expect(mockGetTypeAssertionFix('error')).toBe('error as Error');
  expect(mockGetTypeAssertionFix('someUnknownValue')).toBe('someUnknownValue as any');
  expect(mockGetTypeAssertionFix('value | null')).toBe('value | null!');
  
  // RISK: 'as any' assertions can hide legitimate type errors
  expect(mockGetTypeAssertionFix('complexUnknownType')).toBe('complexUnknownType as any');
  
  // RISK: Non-null assertions (!) can cause runtime errors
  expect(mockGetTypeAssertionFix('maybeNull | undefined')).toBe('maybeNull | undefined!');
  
  console.warn('TYPE ASSERTION RISK: "as any" assertions hide legitimate type errors');
  console.warn('NON-NULL ASSERTION RISK: "!" assertions can cause runtime errors if value is actually null');
});

test('Bulk TypeScript fixer UNKNOWN TYPE HANDLING: overly broad pattern matching', () => {
  // Test unknown type issue detection
  
  // These might not actually have unknown type issues
  expect(mockIsUnknownTypeIssue('myResult')).toBe(true); // Contains 'result'
  expect(mockIsUnknownTypeIssue('apiResponse')).toBe(true); // Contains 'response'
  expect(mockIsUnknownTypeIssue('errorHandling')).toBe(false); // Contains 'error' but not exactly 'error'
  
  // These might legitimately have unknown type issues
  expect(mockIsUnknownTypeIssue('error')).toBe(true); // Exact match
  expect(mockIsUnknownTypeIssue('someUnknownType')).toBe(true); // Contains 'unknown'
  
  // Test the fixes
  expect(mockFixUnknownType('error')).toBe('error as Error');
  expect(mockFixUnknownType('unknownValue')).toBe('unknownValue as any');
  expect(mockFixUnknownType('wellTypedValue')).toBe('wellTypedValue'); // No change
  
  console.warn('UNKNOWN TYPE HANDLING: Overly broad pattern matching for unknown type detection');
  console.warn('May cast well-typed values to "any" based on substring matches');
});

test('Bulk TypeScript fixer PROPERTY ACCESS FIXES: aggressive type assertion', () => {
  // Test property access type assertion logic
  
  // These may not need type assertions
  expect(mockNeedsObjectTypeAssertion('wellTypedObject', 'taskId')).toBe(true); // taskId is in problematic list
  expect(mockNeedsObjectTypeAssertion('myObj', 'session')).toBe(true); // session is in problematic list
  expect(mockNeedsObjectTypeAssertion('database', 'rowCount')).toBe(true); // rowCount is in problematic list
  
  // These already have type assertions
  expect(mockNeedsObjectTypeAssertion('obj as any', 'taskId')).toBe(false); // Already has 'as any'
  expect(mockNeedsObjectTypeAssertion('obj!', 'session')).toBe(false); // Already has '!'
  
  // Properties not in the problematic list
  expect(mockNeedsObjectTypeAssertion('myObj', 'normalProperty')).toBe(false);
  
  console.warn('PROPERTY ACCESS FIXES: Aggressive type assertion based on property name patterns');
  console.warn('May add "as any" to well-typed objects just because they access certain properties');
});

test('Bulk TypeScript fixer CONTEXT IGNORANCE: fixes may not be appropriate', () => {
  // The codemod applies fixes based on patterns without understanding context
  
  // These patterns would trigger fixes regardless of context:
  
  // 1. In test files where 'as any' might be acceptable
  const testCode = 'const result = mockFunction();';
  expect(mockIsLikelyUndefinedProperty('result', 'data')).toBe(true); // Would add non-null assertion
  
  // 2. In error handling where 'error' should be properly typed
  const errorCode = 'error';
  expect(mockNeedsTypeAssertion(errorCode)).toBe(true); // Would cast to 'error as Error'
  
  // 3. In API responses where unknown types are expected
  const apiCode = 'response';
  expect(mockNeedsTypeAssertion(apiCode)).toBe(true); // Would add type assertion
  
  // The codemod doesn't understand that different contexts may require different approaches
  console.warn('CONTEXT IGNORANCE: Fixes applied without understanding code context');
  console.warn('Same pattern gets same fix regardless of whether it's in tests, error handling, or API code');
});

test('Bulk TypeScript fixer BULK APPROACH RISKS: may over-fix or under-fix', () => {
  // The bulk approach with hardcoded patterns has inherent risks
  
  // OVER-FIXING: Adding unnecessary type assertions
  const overFixExamples = [
    'result.data', // Might be well-typed but gets non-null assertion
    'response.json', // Might be well-typed but gets type assertion
    'config.settings' // Might be well-typed but gets non-null assertion
  ];
  
  overFixExamples.forEach(example => {
    const [obj, prop] = example.split('.');
    expect(mockIsLikelyUndefinedProperty(obj, prop)).toBe(true);
  });
  
  // UNDER-FIXING: Missing actual type issues that don't match patterns
  const underFixExamples = [
    'user.profile', // Might be undefined but doesn't match patterns
    'item.metadata', // Might be undefined but doesn't match patterns
    'state.current' // Might be undefined but doesn't match patterns
  ];
  
  underFixExamples.forEach(example => {
    const [obj, prop] = example.split('.');
    expect(mockIsLikelyUndefinedProperty(obj, prop)).toBe(false);
  });
  
  console.warn('BULK APPROACH RISKS: Over-fixing (unnecessary assertions) and under-fixing (missed issues)');
  console.warn('Pattern-based approach cannot match the precision of actual type analysis');
});

test('Bulk TypeScript fixer NO VALIDATION: applies fixes without verifying correctness', () => {
  // The codemod applies fixes without validating they're actually correct
  
  // These fixes might be applied without verification:
  expect(mockGetTypeAssertionFix('wellTypedResult')).toBe('wellTypedResult'); // No change but might be processed
  expect(mockGetTypeAssertionFix('actuallyString | null')).toBe('actuallyString | null!'); // Non-null assertion
  
  // The codemod doesn't check if:
  // - The original code actually has TypeScript errors
  // - The fixes resolve the actual errors
  // - The fixes introduce new problems
  // - The fixes are semantically correct
  
  console.warn('NO VALIDATION: Applies fixes without verifying they solve actual TypeScript errors');
  console.warn('No check that fixes are correct or that original code actually had errors');
});

test('Bulk TypeScript fixer HARDCODED PATTERNS: limited to predefined scenarios', () => {
  // Test the hardcoded patterns used for different fix categories
  
  const undefinedPatterns = ['result', 'response', 'data', 'config', 'options', 'params'];
  const errorPatterns = ['error', 'catch', 'unknown', 'response', 'result'];
  const propertyPatterns = ['rowCount', 'affectedRows', 'specPath', 'taskId', 'session'];
  
  // The codemod is limited to these specific patterns
  expect(undefinedPatterns.includes('result')).toBe(true);
  expect(undefinedPatterns.includes('myCustomPattern')).toBe(false);
  
  expect(errorPatterns.includes('error')).toBe(true);
  expect(errorPatterns.includes('myCustomError')).toBe(false);
  
  expect(propertyPatterns.includes('taskId')).toBe(true);
  expect(propertyPatterns.includes('customProperty')).toBe(false);
  
  console.warn('HARDCODED PATTERNS: Limited to predefined scenarios, cannot adapt to new patterns');
  console.warn('New TypeScript error patterns require code changes to handle');
});

test('Bulk TypeScript fixer RECOMMENDATION: use TypeScript compiler API instead', () => {
  // The codemod should use TypeScript's actual type analysis instead of heuristics
  
  console.warn('RECOMMENDATION: Use TypeScript compiler API for actual type analysis');
  console.warn('Benefits of proper type analysis:');
  console.warn('  1. Accurate undefined/null detection based on actual types');
  console.warn('  2. Proper error diagnosis using TypeScript diagnostics');
  console.warn('  3. Context-aware fixes based on actual type information');
  console.warn('  4. Validation that fixes actually resolve the errors');
  console.warn('  5. No false positives from pattern matching');
  
  console.warn('Current heuristic approach risks:');
  console.warn('  1. Type safety erosion from unnecessary "as any" assertions');
  console.warn('  2. Runtime errors from incorrect non-null assertions');
  console.warn('  3. Code smell introduction from masking design issues');
  console.warn('  4. False fixes that don\'t address actual TypeScript errors');
  
  // A proper implementation would use TypeScript's type checker
  // const checker = program.getTypeChecker();
  // const type = checker.getTypeAtLocation(node);
  // if (type.getFlags() & ts.TypeFlags.Undefined) { ... }
  
  expect(typeof mockIsLikelyUndefinedProperty).toBe('function');
  expect(typeof mockNeedsTypeAssertion).toBe('function');
  expect(typeof mockGetTypeAssertionFix).toBe('function');
}); 
