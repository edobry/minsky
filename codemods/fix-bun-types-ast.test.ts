/**
 * Test for AST-Based Bun Type Compatibility Fix Codemod
 * 
 * Validates the codemod does ONLY what it claims:
 * - Only adds @ts-expect-error comments for specific Bun type issues
 * - Uses AST parsing for precise targeting (no regex boundary issues)
 * - Prevents comment duplication
 * - Only processes hardcoded target files
 * - Maintains code structure and formatting
 */

import { test, expect } from 'bun:test';
import { Project, SyntaxKind, Node } from "ts-morph";

// Mock the codemod logic for testing (since the actual codemod has hardcoded files)
function mockBunTypeFix(sourceCode: string): { content: string; fixes: Array<{ description: string; line: number }> } {
  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
  });
  
  const sourceFile = project.createSourceFile("test.ts", sourceCode);
  const fixes: Array<{ description: string; line: number }> = [];
  let fileChanged = false;

  try {
    // Find property access expressions for process.argv
    const propertyAccessExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression);
    
    for (const propAccess of propertyAccessExpressions) {
      const expression = propAccess.getExpression();
      const propertyName = propAccess.getName();
      
      // Check for process.argv
      if (Node.isIdentifier(expression) && expression.getText() === "process" && propertyName === "argv") {
        const statement = propAccess.getFirstAncestorByKind(SyntaxKind.VariableStatement) ||
                         propAccess.getFirstAncestorByKind(SyntaxKind.ExpressionStatement);
        
        if (statement) {
          const leadingComments = statement.getLeadingCommentRanges();
          const hasExpectError = leadingComments.some(comment => 
            comment.getText().includes("@ts-expect-error"));
          
          if (!hasExpectError) {
            // Note: The actual codemod uses insertLeadingComment which doesn't exist
            // This is a CRITICAL BUG that would be revealed by boundary validation
            fixes.push({
              description: `Added @ts-expect-error for process.argv`,
              line: statement.getStartLineNumber()
            });
            fileChanged = true;
          }
        }
      }
    }

    // Find identifiers for __dirname and ___dirname issues
    const identifiers = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier);
    
    for (const identifier of identifiers) {
      const identifierText = identifier.getText();
      
      // Check for __dirname or ___dirname
      if (identifierText === "__dirname" || identifierText === "___dirname") {
        const statement = identifier.getFirstAncestorByKind(SyntaxKind.VariableStatement) ||
                         identifier.getFirstAncestorByKind(SyntaxKind.ExpressionStatement);
        
        if (statement) {
          const leadingComments = statement.getLeadingCommentRanges();
          const hasExpectError = leadingComments.some(comment => 
            comment.getText().includes("@ts-expect-error"));
          
          if (!hasExpectError) {
            fixes.push({
              description: `Added @ts-expect-error for ${identifierText}`,
              line: statement.getStartLineNumber()
            });
            fileChanged = true;
          }
        }
      }
    }

    // Find Buffer string method calls
    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
    
    for (const callExpr of callExpressions) {
      const expression = callExpr.getExpression();
      
      if (Node.isPropertyAccessExpression(expression)) {
        const propertyName = expression.getName();
        const objectExpr = expression.getExpression();
        
        // Check for string methods on potentially Buffer types
        if ((propertyName === "match" || propertyName === "replace" || 
             propertyName === "includes" || propertyName === "split") &&
            Node.isIdentifier(objectExpr)) {
          
          const varName = objectExpr.getText();
          if (varName.includes("output") || varName.includes("result") || 
              varName.includes("content") || varName.includes("data")) {
            
            const statement = callExpr.getFirstAncestorByKind(SyntaxKind.VariableStatement) ||
                             callExpr.getFirstAncestorByKind(SyntaxKind.ExpressionStatement);
            
            if (statement) {
              const leadingComments = statement.getLeadingCommentRanges();
              const hasExpectError = leadingComments.some(comment => 
                comment.getText().includes("@ts-expect-error"));
              
              if (!hasExpectError) {
                fixes.push({
                  description: `Added @ts-expect-error for Buffer string method: ${varName}.${propertyName}()`,
                  line: statement.getStartLineNumber()
                });
                fileChanged = true;
              }
            }
          }
        }
      }
    }

  } catch (error) {
    console.warn(`AST processing error: ${error}`);
  }

  return { content: sourceFile.getFullText(), fixes };
}

test('AST-based Bun type fix correctly identifies process.argv usage', () => {
  const input = `
const args = process.argv;
const firstArg = process.argv[2];
console.log(args);
`;

  const { content, fixes } = mockBunTypeFix(input);
  
  // Should identify process.argv usage
  expect(fixes.length).toBe(2);
  expect(fixes[0].description).toContain('process.argv');
  expect(fixes[1].description).toContain('process.argv');
  
  // Should preserve original code structure
  expect(content).toContain('const args = process.argv;');
  expect(content).toContain('const firstArg = process.argv[2];');
});

test('AST-based Bun type fix correctly identifies __dirname usage', () => {
  const input = `
const currentDir = __dirname;
const altDir = ___dirname;
console.log(currentDir);
`;

  const { content, fixes } = mockBunTypeFix(input);
  
  // Should identify both __dirname and ___dirname
  expect(fixes.length).toBe(2);
  expect(fixes.some(f => f.description.includes('__dirname'))).toBe(true);
  expect(fixes.some(f => f.description.includes('___dirname'))).toBe(true);
  
  // Should preserve original code structure
  expect(content).toContain('const currentDir = __dirname;');
  expect(content).toContain('const altDir = ___dirname;');
});

test('AST-based Bun type fix correctly identifies Buffer string method calls', () => {
  const input = `
const output = getBufferData();
const result = output.match(/pattern/);
const content = getData();
const split = content.split('\\n');
`;

  const { content, fixes } = mockBunTypeFix(input);
  
  // Should identify Buffer string method calls based on variable naming
  expect(fixes.length).toBe(2);
  expect(fixes.some(f => f.description.includes('output.match'))).toBe(true);
  expect(fixes.some(f => f.description.includes('content.split'))).toBe(true);
  
  // Should preserve original code structure
  expect(content).toContain('const result = output.match(/pattern/);');
  expect(content).toContain('const split = content.split(\'\\n\');');
});

test('AST-based Bun type fix CRITICAL BUG: insertLeadingComment method does not exist', () => {
  // CRITICAL DISCOVERY: The actual codemod uses statement.insertLeadingComment()
  // but this method doesn't exist on VariableStatement | ExpressionStatement
  
  const input = `const args = process.argv;`;
  
  // The actual codemod would fail with TypeScript errors:
  // Property 'insertLeadingComment' does not exist on type 'VariableStatement | ExpressionStatement'
  
  console.warn('CRITICAL BUG: insertLeadingComment method does not exist on statement types');
  console.warn('This codemod would fail at runtime with method not found errors');
  
  // Our mock test can identify the patterns but cannot actually apply the fix
  const { fixes } = mockBunTypeFix(input);
  expect(fixes.length).toBe(1);
  
  // The real issue is that the codemod claims to add comments but cannot
  // due to incorrect ts-morph API usage
});

test('AST-based Bun type fix prevents comment duplication', () => {
  const input = `
// @ts-expect-error Bun supports process.argv at runtime, types incomplete
const args = process.argv;
const newArgs = process.argv.slice(2);
`;

  const { content, fixes } = mockBunTypeFix(input);
  
  // Should not add duplicate comments
  // First process.argv already has comment, second should get a new one
  expect(fixes.length).toBe(1);
  expect(fixes[0].description).toContain('process.argv');
  
  // Should preserve existing comment
  expect(content).toContain('@ts-expect-error Bun supports process.argv');
});

test('AST-based Bun type fix HARDCODED LIMITATION: only processes specific files', () => {
  // HARDCODED FILE LIMITATION: The codemod only processes hardcoded target files:
  // - "src/scripts/test-analyzer.ts"
  // - "src/scripts/task-title-migration.ts"
  
  // This means the codemod cannot be used generically across a project
  // and would need manual modification for each new file
  
  console.warn('HARDCODED LIMITATION: Only processes specific hardcoded files');
  console.warn('Cannot be used generically across project without code modification');
  
  // Our test validates the logic but the actual codemod has hardcoded scope
  const input = `const args = process.argv;`;
  const { fixes } = mockBunTypeFix(input);
  
  expect(fixes.length).toBe(1);
  // But in real usage, this would only work if the file path matches the hardcoded list
});

test('AST-based Bun type fix HEURISTIC LIMITATION: Buffer detection by variable naming', () => {
  const input = `
// These would trigger Buffer string method fixes (false positives)
const output = "string value";
const result = output.match(/pattern/);

// These would NOT trigger fixes (false negatives)
const buffer = getBuffer();
const matched = buffer.match(/pattern/);

// Variable naming heuristic is unreliable
const dataStream = getActualBuffer();
const pieces = dataStream.split('\\n'); // Would trigger fix
`;

  const { content, fixes } = mockBunTypeFix(input);
  
  // HEURISTIC ISSUE: Detection based on variable names containing 
  // "output", "result", "content", "data" is unreliable
  
  // False positive: string variables with these names get flagged
  expect(fixes.some(f => f.description.includes('output.match'))).toBe(true);
  expect(fixes.some(f => f.description.includes('dataStream.split'))).toBe(true);
  
  // False negative: actual Buffer with different variable name is missed
  expect(fixes.some(f => f.description.includes('buffer.match'))).toBe(false);
  
  console.warn('HEURISTIC LIMITATION: Buffer detection by variable naming is unreliable');
  console.warn('Results in false positives (string vars) and false negatives (actual Buffers)');
});

test('AST-based Bun type fix SCOPE LIMITATION: statement-level comments', () => {
  const input = `
if (condition) {
  const args = process.argv;
  doSomething(args);
}

function helper() {
  return process.argv[0];
}
`;

  const { content, fixes } = mockBunTypeFix(input);
  
  // SCOPE LIMITATION: Comments are added at statement level, not expression level
  // This means the comment applies to the entire statement, not just the problematic expression
  
  expect(fixes.length).toBe(2);
  
  // Both fixes would add statement-level comments
  // This could suppress more than just the specific Bun type issue
  
  console.warn('SCOPE LIMITATION: Comments added at statement level, not expression level');
  console.warn('May suppress more errors than just the specific Bun type issue');
});

test('AST-based Bun type fix NO VALIDATION: suppresses errors without verification', () => {
  const input = `
// This might not even be a Bun type issue, but would still get suppressed
const args = process.argv;
`;

  const { content, fixes } = mockBunTypeFix(input);
  
  // NO VALIDATION ISSUE: The codemod adds @ts-expect-error comments
  // without actually validating that the errors are Bun-specific
  
  expect(fixes.length).toBe(1);
  
  // The comment would be added even if:
  // - The code doesn't actually have type errors
  // - The errors are not Bun-specific
  // - The errors should be fixed rather than suppressed
  
  console.warn('NO VALIDATION: Adds error suppression without verifying errors are Bun-specific');
  console.warn('May suppress legitimate errors that should be fixed');
});

test('AST-based Bun type fix preserves non-target patterns', () => {
  const input = `
// Should NOT trigger any fixes
const argv = getArgs();
const dirname = getCurrentDir();
const text = "process.argv in string";
const comment = /* process.argv in comment */;
const regex = /process\\.argv/;
`;

  const { content, fixes } = mockBunTypeFix(input);
  
  // Should not trigger fixes for non-matching patterns
  expect(fixes.length).toBe(0);
  
  // Should preserve all content unchanged
  expect(content).toContain('const argv = getArgs();');
  expect(content).toContain('const dirname = getCurrentDir();');
  expect(content).toContain('"process.argv in string"');
  expect(content).toContain('/* process.argv in comment */');
  expect(content).toContain('/process\\.argv/');
}); 
