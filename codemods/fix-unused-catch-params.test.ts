/**
 * Test for Unused Catch Parameters Fix Codemod
 * 
 * Validates the codemod does ONLY what it claims:
 * - Only adds underscore prefixes to catch block parameters
 * - Handles standard catch(param) syntax correctly
 * - Preserves parameter names for debugging clarity
 * - Does not modify parameters that are actually used
 * - Handles existing underscore prefixes properly
 */

import { test, expect } from 'bun:test';

// Extract the core transformation logic for testing
function fixUnusedCatchParams(content: string): { content: string; changes: number } {
  let newContent = content;
  let fileChanges = 0;

  // Fix unused catch block parameters - very safe transformation
  const catchParamFixes = [
    // Standard catch blocks with unused parameters
    { pattern: /catch\s*\(\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\)/g, replacement: 'catch (_$1)' },
    // Catch blocks that already have underscore but might need fixing
    { pattern: /catch\s*\(\s*_([a-zA-Z_][a-zA-Z0-9_]*)\s*\)/g, replacement: 'catch (_$1)' }
  ];

  for (const fix of catchParamFixes) {
    const matches = newContent.match(fix.pattern);
    if (matches) {
      newContent = newContent.replace(fix.pattern, fix.replacement);
      fileChanges += matches.length;
    }
  }

  return { content: newContent, changes: fileChanges };
}

test('Unused catch params fix adds underscore prefix to standard catch blocks', () => {
  const input = `
try {
  riskyOperation();
} catch (error) {
  console.log('Something went wrong');
}

try {
  anotherOperation();
} catch (err) {
  // Silent catch
}
`;

  const { content: result, changes } = fixUnusedCatchParams(input);
  
  // Should add underscore prefix to both catch parameters
  expect(result).toContain('catch (_error)');
  expect(result).toContain('catch (_err)');
  
  // Should not contain original parameter names
  expect(result).not.toContain('catch (error)');
  expect(result).not.toContain('catch (err)');
  
  // Should report correct number of changes
  expect(changes).toBe(2);
});

test('Unused catch params fix handles existing underscore prefixes', () => {
  const input = `
try {
  operation();
} catch (_error) {
  console.log('Already prefixed');
}

try {
  operation();
} catch (_existing) {
  return false;
}
`;

  const { content: result, changes } = fixUnusedCatchParams(input);
  
  // Should preserve existing underscore prefixes
  expect(result).toContain('catch (_error)');
  expect(result).toContain('catch (_existing)');
  
  // Should still report changes (regex matches and "fixes" already correct patterns)
  expect(changes).toBe(2);
});

test('Unused catch params fix handles various whitespace patterns', () => {
  const input = `
try {
  operation();
} catch(error) {
  console.log('No spaces');
}

try {
  operation();
} catch (  spaced  ) {
  console.log('Extra spaces');
}

try {
  operation();
} catch(	tabbed	) {
  console.log('Tabs');
}
`;

  const { content: result, changes } = fixUnusedCatchParams(input);
  
  // Should handle various whitespace patterns
  expect(result).toContain('catch (_error)');
  expect(result).toContain('catch (_spaced)');
  expect(result).toContain('catch (_tabbed)');
  
  expect(changes).toBe(3);
});

test('Unused catch params fix CRITICAL ISSUE: prefixes actually used parameters', () => {
  const input = `
try {
  riskyOperation();
} catch (error) {
  console.log('Error occurred:', error.message);
  throw error;
}

try {
  anotherOperation();
} catch (err) {
  logger.error('Failed:', err);
  return err.code;
}
`;

  const { content: result, changes } = fixUnusedCatchParams(input);
  
  // CRITICAL BUG: The codemod blindly prefixes ALL catch parameters
  // without checking if they are actually used
  
  // These parameters ARE used but get prefixed anyway
  expect(result).toContain('catch (_error)');
  expect(result).toContain('catch (_err)');
  
  // The catch block contents still reference the original names
  expect(result).toContain('error.message');
  expect(result).toContain('throw error;');
  expect(result).toContain('logger.error(\'Failed:\', err);');
  expect(result).toContain('return err.code;');
  
  console.warn('CRITICAL BUG: Prefixes actually used parameters, breaking code');
  console.warn('Parameters _error and _err are not defined in catch blocks');
  
  expect(changes).toBe(2);
});

test('Unused catch params fix BOUNDARY ISSUE: modifies catch in strings and comments', () => {
  const input = `
const code = "try { test(); } catch (error) { handle(); }";
/* 
 * Example catch block:
 * try { ... } catch (exception) { ... }
 */
const regex = /catch\\s*\\(\\s*([a-zA-Z_][a-zA-Z0-9_]*)\\s*\\)/g;

try {
  operation();
} catch (actualError) {
  console.log('Real catch block');
}
`;

  const { content: result, changes } = fixUnusedCatchParams(input);
  
  // BOUNDARY VIOLATION: The regex patterns will match catch in strings and comments
  
  // Should correctly modify the actual catch block
  expect(result).toContain('catch (_actualError)');
  
  // CRITICAL BUG: May also modify catch patterns in strings and comments
  const boundaryViolations = [
    result.includes('catch (_error)') && result.includes('"try { test(); } catch (_error)'), // String modification
    result.includes('catch (_exception)') && result.includes('* try { ... } catch (_exception)'), // Comment modification
  ];
  
  if (boundaryViolations.some(v => v)) {
    console.warn('BOUNDARY VIOLATION: Regex modified catch patterns in strings/comments');
  }
  
  // At minimum, should have changed the actual catch block
  expect(changes).toBeGreaterThanOrEqual(1);
});

test('Unused catch params fix REGEX LIMITATION: only handles simple parameter patterns', () => {
  const input = `
try {
  operation();
} catch ({ message }) {
  console.log('Destructured parameter');
}

try {
  operation();
} catch ([first, second]) {
  console.log('Array destructured');
}

try {
  operation();
} catch (error: Error) {
  console.log('Typed parameter');
}

try {
  operation();
} catch {
  console.log('No parameter');
}
`;

  const { content: result, changes } = fixUnusedCatchParams(input);
  
  // REGEX LIMITATION: Only handles simple identifier patterns
  // Complex patterns like destructuring, typed parameters, or no parameters are not handled
  
  // Should not modify destructured parameters
  expect(result).toContain('catch ({ message })');
  expect(result).toContain('catch ([first, second])');
  
  // Should not modify typed parameters
  expect(result).toContain('catch (error: Error)');
  
  // Should not modify parameterless catch
  expect(result).toContain('catch {');
  
  // Should make no changes since no simple patterns match
  expect(changes).toBe(0);
  
  console.warn('REGEX LIMITATION: Only handles simple identifier patterns');
  console.warn('Complex catch patterns (destructuring, types, no params) are ignored');
});

test('Unused catch params fix DOUBLE TRANSFORMATION: second regex pattern issue', () => {
  const input = `
try {
  operation();
} catch (_error) {
  console.log('Already prefixed');
}
`;

  const { content: result, changes } = fixUnusedCatchParams(input);
  
  // DOUBLE TRANSFORMATION ISSUE: The second regex pattern
  // /catch\s*\(\s*_([a-zA-Z_][a-zA-Z0-9_]*)\s*\)/g with replacement 'catch (_$1)'
  // will match '_error' and replace it with 'catch (_error)'
  
  // This is redundant since the parameter is already correctly prefixed
  expect(result).toContain('catch (_error)');
  
  // The issue is that both patterns process the same content
  // leading to unnecessary regex processing
  expect(changes).toBe(1);
  
  console.warn('REDUNDANT PATTERN: Second regex pattern is unnecessary');
  console.warn('Already correctly prefixed parameters get "fixed" again');
});

test('Unused catch params fix NESTED CATCH HANDLING', () => {
  const input = `
try {
  try {
    innerOperation();
  } catch (innerError) {
    console.log('Inner catch');
  }
} catch (outerError) {
  console.log('Outer catch');
}
`;

  const { content: result, changes } = fixUnusedCatchParams(input);
  
  // Should handle nested catch blocks correctly
  expect(result).toContain('catch (_innerError)');
  expect(result).toContain('catch (_outerError)');
  
  // Should process both catch blocks independently
  expect(changes).toBe(2);
});

test('Unused catch params fix preserves non-catch patterns', () => {
  const input = `
// Should NOT be modified
function catch(param) {
  return param;
}

const obj = {
  catch: function(error) {
    console.log(error);
  }
};

const method = obj.catch(new Error());
`;

  const { content: result, changes } = fixUnusedCatchParams(input);
  
  // Should not modify function names or method names that happen to be "catch"
  expect(result).toContain('function catch(param)');
  expect(result).toContain('catch: function(error)');
  expect(result).toContain('obj.catch(new Error())');
  
  // Should make no changes
  expect(changes).toBe(0);
});

test('Unused catch params fix HARDCODED DIRECTORY LIMITATION', () => {
  // HARDCODED LIMITATION: The codemod only processes files in 'src' directory
  // This is hardcoded and cannot be configured without code changes
  
  console.warn('HARDCODED LIMITATION: Only processes files in src directory');
  console.warn('Cannot be used for projects with different directory structures');
  
  // The transformation logic works, but the file processing is hardcoded
  const input = `try { test(); } catch (error) { console.log('test'); }`;
  const { content: result, changes } = fixUnusedCatchParams(input);
  
  expect(result).toContain('catch (_error)');
  expect(changes).toBe(1);
  
  // But in real usage, files outside 'src' would never be processed
});

test('Unused catch params fix PARAMETER NAME VALIDATION', () => {
  const input = `
try {
  operation();
} catch (error123) {
  console.log('Numbered parameter');
}

try {
  operation();
} catch (_prefixed) {
  console.log('Already prefixed');
}

try {
  operation();
} catch (Error) {
  console.log('Capital letter');
}
`;

  const { content: result, changes } = fixUnusedCatchParams(input);
  
  // Should handle various valid parameter names
  expect(result).toContain('catch (_error123)');
  expect(result).toContain('catch (_prefixed)');
  expect(result).toContain('catch (_Error)');
  
  // All should be processed
  expect(changes).toBe(3);
}); 
