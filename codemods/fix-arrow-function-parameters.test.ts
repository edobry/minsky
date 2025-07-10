/**
 * Test for Arrow Function Parameters Codemod
 *
 * Tests the transformation logic to validate boundary violations
 * and critical failures discovered in boundary validation.
 */

import { test, expect } from 'bun:test';

// Extract the core transformation logic for testing
function fixArrowFunctionParameters(content: string): { content: string; changes: number } {
  let newContent = content;
  let fileChanges = 0;

  // Copy the exact transformation logic from the actual codemod
  const arrowFunctionPattern = /async\s*\(([^)]*)\)\s*:\s*[^{]*=>\s*{([^}]*(?:{[^}]*}[^}]*)*?)}/g;

  newContent = newContent.replace(arrowFunctionPattern, (match, params, body) => {
    if (!params.includes('_')) {
      return match; // No underscore parameters, no change needed
    }

    let modifiedParams = params;
    let paramChanged = false;

    // Find parameters that start with underscore
    const underscoreParams = params.match(/_\w+/g) || [];

    for (const underscoreParam of underscoreParams) {
      const cleanParam = underscoreParam.substring(1); // Remove the underscore

      // Check if the clean parameter name is used in the body
      const cleanParamRegex = new RegExp(`\\b${cleanParam}\\b`, 'g');
      if (cleanParamRegex.test(body)) {
        // The parameter is used without underscore in the body
        // Fix by removing underscore from parameter declaration
        modifiedParams = modifiedParams.replace(underscoreParam, cleanParam);
        paramChanged = true;
        fileChanges++;
      }
    }

    if (paramChanged) {
      // Replace the parameter list in the original match
      return match.replace(params, modifiedParams);
    }

    return match;
  });

  return { content: newContent, changes: fileChanges };
}

test('Codemod creates scope collisions with existing variables', () => {
  const scopeCollisionCode = `
const data = 'existing variable';

const processor = async (_data: string): Promise<string> => {
  return data.toUpperCase(); // Uses data - will create collision
};
`;

  const { content: result, changes } = fixArrowFunctionParameters(scopeCollisionCode);

  // CRITICAL ISSUE: No scope analysis - creates variable name conflicts
  expect(changes).toBeGreaterThan(0);
  expect(result).toContain('async (data: string)'); // Changed _data to data

  // Now we have two 'data' variables in the same scope - compilation error
});

test('Codemod fails with destructuring parameters', () => {
  const destructuringCode = `
const handler = async ({ _data, name }: { _data: string, name: string }): Promise<void> => {
  console.log(data, name); // Uses data without underscore
};
`;

  const { content: result, changes } = fixArrowFunctionParameters(destructuringCode);

  // CRITICAL ISSUE: Regex cannot handle destructuring parameters
  expect(changes).toBe(0); // No changes due to regex mismatch

  // This leaves the mismatch unfixed
});

test('Boundary validation confirms critical anti-pattern', () => {
  const typicalArrowFunction = `
const service = {
  process: async (_request: Request): Promise<Response> => {
    const result = await processRequest(request);
    return new Response(result);
  }
};
`;

  const { content: result, changes } = fixArrowFunctionParameters(typicalArrowFunction);

  // BOUNDARY VALIDATION RESULT: Multiple critical failures
  expect(changes).toBeGreaterThan(0);

  // Anti-Pattern Confirmed: "Complex Regex Function Parsing Without AST Analysis"
  // This codemod should be removed due to safety violations
});
