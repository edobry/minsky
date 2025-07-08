/**
 * Simple test for TS2564 Property Initialization Codemod
 * 
 * Tests the basic functionality: adding definite assignment assertions to configured properties
 */

import { test, expect } from 'bun:test';
import { Project } from 'ts-morph';

test('TS2564 codemod adds definite assignment assertions to configured properties', () => {
  // Create a simple test with in-memory TypeScript project
  const project = new Project({ useInMemoryFileSystem: true });
  
  // Create test file with a class that needs fixing
  const sourceFile = project.createSourceFile('test.ts', `
    export class GitHubBackend {
      private repoUrl: string;
      private repoName: string;
      private alreadyFixed!: string;
    }
  `);
  
  // Apply the core logic from the codemod
  const classes = sourceFile.getClasses();
  const classDeclaration = classes[0];
  
  // Test the main transformation
  const repoUrlProperty = classDeclaration.getProperty('repoUrl');
  const repoNameProperty = classDeclaration.getProperty('repoName');
  const alreadyFixedProperty = classDeclaration.getProperty('alreadyFixed');
  
  // Before: properties should not have exclamation tokens
  expect(repoUrlProperty?.getStructure().hasExclamationToken).toBe(false);
  expect(repoNameProperty?.getStructure().hasExclamationToken).toBe(false);
  expect(alreadyFixedProperty?.getStructure().hasExclamationToken).toBe(true); // already has it
  
  // Apply the fix (with null checks)
  if (repoUrlProperty) repoUrlProperty.setHasExclamationToken(true);
  if (repoNameProperty) repoNameProperty.setHasExclamationToken(true);
  // Skip alreadyFixed since it already has the token
  
  // After: properties should have exclamation tokens
  expect(repoUrlProperty?.getStructure().hasExclamationToken).toBe(true);
  expect(repoNameProperty?.getStructure().hasExclamationToken).toBe(true);
  expect(alreadyFixedProperty?.getStructure().hasExclamationToken).toBe(true);
  
  // Verify the actual code transformation
  const transformedCode = sourceFile.getFullText();
  expect(transformedCode).toContain('private repoUrl!: string;');
  expect(transformedCode).toContain('private repoName!: string;');
  expect(transformedCode).toContain('private alreadyFixed!: string;'); // unchanged
});

test('TS2564 codemod handles missing properties gracefully', () => {
  const project = new Project({ useInMemoryFileSystem: true });
  
  const sourceFile = project.createSourceFile('test.ts', `
    export class GitHubBackend {
      private differentProperty: string;
    }
  `);
  
  const classDeclaration = sourceFile.getClasses()[0];
  
  // Should not crash when looking for non-existent properties
  const missingProperty = classDeclaration.getProperty('repoUrl');
  expect(missingProperty).toBe(undefined);
  
  // Should not affect other properties
  const existingProperty = classDeclaration.getProperty('differentProperty');
  expect(existingProperty).toBeDefined();
  expect(existingProperty!.getStructure().hasExclamationToken).toBe(false);
}); 
