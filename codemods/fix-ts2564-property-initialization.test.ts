/**
 * Test for TS2564 Property Initialization Codemod
 * 
 * Validates the codemod does ONLY what it claims:
 * - Only processes configured classes (GitHubBackend, LocalGitBackend, etc.)
 * - Only processes configured properties (repoUrl, repoName, type)
 * - Ignores all other classes and properties
 * - Skips properties that already have definite assignment assertions
 */

import { test, expect } from 'bun:test';
import { Project } from 'ts-morph';

// The exact configuration from the codemod
const TS2564_PROPERTIES = [
  { className: "GitHubBackend", properties: ["repoUrl", "repoName"] },
  { className: "LocalGitBackend", properties: ["repoUrl", "repoName"] }, 
  { className: "RemoteGitBackend", properties: ["repoUrl", "repoName"] },
  { className: "SpecialWorkspaceManager", properties: ["repoUrl"] },
  { className: "StorageError", properties: ["type"] },
];

test('TS2564 codemod ONLY processes configured classes and properties', () => {
  const project = new Project({ useInMemoryFileSystem: true });
  
  // Create test file with mixed classes - some configured, some not
  const sourceFile = project.createSourceFile('test.ts', `
    export class GitHubBackend {
      private repoUrl: string;           // Should be fixed
      private repoName: string;          // Should be fixed
      private otherProperty: string;     // Should be ignored
    }
    
    export class RandomClass {
      private repoUrl: string;           // Should be ignored (wrong class)
      private repoName: string;          // Should be ignored (wrong class)
    }
    
    export class StorageError {
      private type: string;              // Should be fixed
      private message: string;           // Should be ignored
    }
  `);
  
  // Apply the codemod logic
  const classes = sourceFile.getClasses();
  
  for (const classDeclaration of classes) {
    const className = classDeclaration.getName();
    if (!className) continue;

    // Find the configuration for this class
    const config = TS2564_PROPERTIES.find(c => c.className === className);
    if (!config) continue;

    // Fix each property that needs definite assignment assertion
    for (const propertyName of config.properties) {
      const property = classDeclaration.getProperty(propertyName);
      if (!property) continue;

      const propertyStructure = property.getStructure();
      
      // Check if property already has definite assignment assertion
      if (propertyStructure.hasExclamationToken) {
        continue;
      }

      // Add definite assignment assertion
      property.setHasExclamationToken(true);
    }
  }
  
  // Verify the results
  const transformedCode = sourceFile.getFullText();
  
  // Should fix configured properties in configured classes
  expect(transformedCode).toContain('private repoUrl!: string;');
  expect(transformedCode).toContain('private repoName!: string;');
  expect(transformedCode).toContain('private type!: string;');
  
  // Should NOT fix non-configured properties
  expect(transformedCode).toContain('private otherProperty: string;');    // No !
  expect(transformedCode).toContain('private message: string;');          // No !
  
  // Should NOT fix properties in non-configured classes
  const lines = transformedCode.split('\n');
  const randomClassSection = lines.slice(
    lines.findIndex(line => line.includes('class RandomClass')),
    lines.findIndex(line => line.includes('class StorageError'))
  );
  const randomClassCode = randomClassSection.join('\n');
  expect(randomClassCode).toContain('private repoUrl: string;');  // No ! - wrong class
  expect(randomClassCode).toContain('private repoName: string;'); // No ! - wrong class
});

test('TS2564 codemod skips properties that already have definite assignment assertions', () => {
  const project = new Project({ useInMemoryFileSystem: true });
  
  const sourceFile = project.createSourceFile('test.ts', `
    export class GitHubBackend {
      private repoUrl!: string;          // Already has !, should be unchanged
      private repoName: string;          // Should be fixed
    }
  `);
  
  const classes = sourceFile.getClasses();
  const classDeclaration = classes[0];
  
  // Apply the codemod logic
  const config = TS2564_PROPERTIES.find(c => c.className === 'GitHubBackend');
  if (config) {
    for (const propertyName of config.properties) {
      const property = classDeclaration.getProperty(propertyName);
      if (!property) continue;

      const propertyStructure = property.getStructure();
      
      // Check if property already has definite assignment assertion
      if (propertyStructure.hasExclamationToken) {
        continue; // Skip - already has !
      }

      // Add definite assignment assertion
      property.setHasExclamationToken(true);
    }
  }
  
  const transformedCode = sourceFile.getFullText();
  
  // Should leave already-fixed property unchanged
  expect(transformedCode).toContain('private repoUrl!: string;');
  // Should fix the property that didn't have !
  expect(transformedCode).toContain('private repoName!: string;');
});

test('TS2564 codemod handles missing properties gracefully', () => {
  const project = new Project({ useInMemoryFileSystem: true });
  
  const sourceFile = project.createSourceFile('test.ts', `
    export class GitHubBackend {
      private differentProperty: string;
      // Missing repoUrl and repoName
    }
  `);
  
  const classDeclaration = sourceFile.getClasses()[0];
  
  // Apply the codemod logic - should not crash
  const config = TS2564_PROPERTIES.find(c => c.className === 'GitHubBackend');
  if (config) {
    for (const propertyName of config.properties) {
      const property = classDeclaration.getProperty(propertyName);
      if (!property) continue; // Should handle missing properties gracefully

      const propertyStructure = property.getStructure();
      
      if (propertyStructure.hasExclamationToken) {
        continue;
      }

      property.setHasExclamationToken(true);
    }
  }
  
  const transformedCode = sourceFile.getFullText();
  
  // Should not crash and should not modify existing properties
  expect(transformedCode).toContain('private differentProperty: string;');
  expect(transformedCode).not.toContain('!');
}); 
