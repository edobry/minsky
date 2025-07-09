/**
 * Test for File-Specific Unused Import Removal Script
 * 
 * ⚠️ WARNING: This demonstrates why this is NOT a proper codemod ⚠️
 * 
 * This test validates the extreme limitations and brittleness of the
 * hardcoded import removal script, showing why it should be removed
 * from the codemod collection.
 */

import { test, expect } from 'bun:test';

// Mock the import removal logic for testing (extracted from the hardcoded script)
function mockFixUnusedImports(content: string, targetFile: string): { content: string; changes: number } {
  // The script only works for one hardcoded file path
  const hardcodedPath = "src/adapters/tests__/integration/session.test.ts";
  
  if (targetFile !== hardcodedPath) {
    // Script would do nothing for any other file
    return { content, changes: 0 };
  }
  
  const lines = content.split("\n");
  let changes = 0;
  
  // Remove unused imports by filtering out specific lines
  const modifiedLines = lines.filter((line, index) => {
    // Skip the unused import lines we identified (HARDCODED LINE NUMBERS)
    if (index >= 1 && index <= 8) {
      // Keep only the bun:test import from the import block
      if (line.includes("getSessionFromParams") || 
          line.includes("listSessionsFromParams") ||
          line.includes("startSessionFromParams") ||
          line.includes("deleteSessionFromParams") ||
          line.includes("SessionDB") ||
          line.includes("type, Session") ||
          line.includes("createSessionDeps")) {
        changes++;
        return false; // Remove this line
      }
    }
    
    // Remove specific unused import lines (HARDCODED IMPORT NAMES)
    if (line.includes("GitService") && line.includes("import")) {
      changes++;
      return false;
    }
    if (line.includes("TaskService") && line.includes("import")) {
      changes++;
      return false;
    }
    if (line.includes("WorkspaceUtils") && line.includes("import")) {
      changes++;
      return false;
    }
    if (line.includes("createMockObject") && !line.includes("createMock,")) {
      // Remove createMockObject but keep createMock and setupTestMocks
      const modified = line.replace(/,\s*createMockObject/, "").trim();
      if (modified !== line && modified !== "") {
        changes++;
      }
      return modified !== "";
    }
    
    return true; // Keep this line
  });
  
  // Clean up the remaining import lines
  const finalLines = modifiedLines.map(line => {
    // Clean up any trailing commas in import statements
    if (line.includes("}, from") && line.includes(",,")) {
      return line.replace(/,,+/g, ",");
    }
    if (line.includes("}, from") && line.endsWith(",")) {
      return line.slice(0, -1);
    }
    return line;
  });
  
  return { content: finalLines.join("\n"), changes };
}

test('Fix unused imports CRITICAL LIMITATION: only works for one hardcoded file', () => {
  const input = `
import { getSessionFromParams, SessionDB } from './session';
import { GitService } from './git';
import { test } from 'bun:test';
`;

  // Test with the hardcoded target file
  const { content: result1, changes: changes1 } = mockFixUnusedImports(input, "src/adapters/tests__/integration/session.test.ts");
  
  // Test with a different file path
  const { content: result2, changes: changes2 } = mockFixUnusedImports(input, "src/other/file.test.ts");
  
  // CRITICAL LIMITATION: Only works for the exact hardcoded file path
  expect(changes1).toBeGreaterThan(0); // Should process the hardcoded file
  expect(changes2).toBe(0); // Should ignore all other files
  
  // Same content, different file path = completely different behavior
  expect(result1).not.toBe(result2);
  expect(result2).toBe(input); // Other files remain unchanged
  
  console.warn('CRITICAL LIMITATION: Hardcoded file path makes this unusable for other files');
});

test('Fix unused imports BRITTLE LINE-BASED FILTERING: hardcoded line numbers', () => {
  // The script filters lines 1-8 based on hardcoded assumptions
  const input = `line 0
line 1 - import { getSessionFromParams } from './session';
line 2 - import { SessionDB } from './db';
line 3 - import { createSessionDeps } from './deps';
line 4 - import { bun } from 'bun:test';
line 5 - import { GitService } from './git';
line 6 - other code
line 7 - more code
line 8 - last filtered line
line 9 - this line won't be filtered
import { getSessionFromParams } from './session'; // This won't be removed!
`;

  const { content: result, changes } = mockFixUnusedImports(input, "src/adapters/tests__/integration/session.test.ts");
  
  // BRITTLE BUG: Line-based filtering means imports outside lines 1-8 are ignored
  expect(result).toContain('line 9'); // Lines after 8 are preserved
  expect(result).toContain("import { getSessionFromParams } from './session'; // This won't be removed!");
  
  // The exact same import on line 10 would NOT be removed because it's outside the hardcoded range
  expect(changes).toBeGreaterThan(0);
  
  console.warn('BRITTLE BUG: Line-based filtering with hardcoded line numbers');
  console.warn('Same imports in different positions have different treatment');
});

test('Fix unused imports NO VALIDATION: removes imports without checking usage', () => {
  const input = `
import { getSessionFromParams } from './session';
import { test } from 'bun:test';

test('example', () => {
  // This import is actually USED but would still be removed
  const result = getSessionFromParams('test');
  expect(result).toBeTruthy();
});
`;

  const { content: result, changes } = mockFixUnusedImports(input, "src/adapters/tests__/integration/session.test.ts");
  
  // NO VALIDATION BUG: The script removes imports without checking if they're actually used
  expect(result).not.toContain('getSessionFromParams');
  expect(result).toContain('const result = getSessionFromParams(\'test\');'); // Usage remains!
  
  // This would create a broken file with undefined references
  console.warn('NO VALIDATION BUG: Removes imports without checking actual usage');
  console.warn('This would create broken code with undefined references');
  
  expect(changes).toBeGreaterThan(0);
});

test('Fix unused imports HARDCODED IMPORT NAMES: only removes specific predefined imports', () => {
  const input = `
import { getSessionFromParams, otherUnusedImport } from './session';
import { GitService } from './git';
import { RandomUnusedImport } from './random';
import { test } from 'bun:test';
`;

  const { content: result, changes } = mockFixUnusedImports(input, "src/adapters/tests__/integration/session.test.ts");
  
  // HARDCODED LIMITATION: Only removes specific predefined import names
  expect(result).not.toContain('getSessionFromParams'); // Removed (in hardcoded list)
  expect(result).not.toContain('GitService'); // Removed (in hardcoded list)
  expect(result).toContain('otherUnusedImport'); // NOT removed (not in hardcoded list)
  expect(result).toContain('RandomUnusedImport'); // NOT removed (not in hardcoded list)
  
  // The script has no generic logic to detect unused imports
  console.warn('HARDCODED LIMITATION: Only removes specific predefined import names');
  console.warn('Cannot detect or remove other unused imports');
  
  expect(changes).toBeGreaterThan(0);
});

test('Fix unused imports NO TYPESCRIPT AWARENESS: string-based line filtering', () => {
  const input = `
import { getSessionFromParams } from './session';
// This comment mentions getSessionFromParams but shouldn't affect imports
const code = "import { getSessionFromParams } from './session';";
import { GitService } from './git';
`;

  const { content: result, changes } = mockFixUnusedImports(input, "src/adapters/tests__/integration/session.test.ts");
  
  // NO TYPESCRIPT AWARENESS: Uses crude string contains() checks
  // This could potentially match import names in comments, strings, etc.
  
  // Should remove the actual import line
  expect(result).not.toContain("import { getSessionFromParams } from './session';");
  
  // But should preserve comments and strings (though the logic is fragile)
  expect(result).toContain('// This comment mentions getSessionFromParams');
  expect(result).toContain('const code = "import { getSessionFromParams } from \'./session\';";');
  
  console.warn('NO TYPESCRIPT AWARENESS: Uses crude string matching instead of AST parsing');
  console.warn('Could potentially match import names in inappropriate contexts');
  
  expect(changes).toBeGreaterThan(0);
});

test('Fix unused imports NOT REUSABLE: cannot be applied to other projects', () => {
  // The script is completely project-specific and cannot be reused
  const input = `
import { SomeUnusedImport } from './module';
import { AnotherUnusedImport } from './other';
`;

  // Even if we had a different project with unused imports,
  // this script would be completely useless
  const { content: result, changes } = mockFixUnusedImports(input, "some/other/project/file.ts");
  
  // NO CHANGES: Script is useless for any other project or file structure
  expect(result).toBe(input);
  expect(changes).toBe(0);
  
  console.warn('NOT REUSABLE: Script is completely project-specific');
  console.warn('Cannot be applied to other projects or file structures');
});

test('Fix unused imports SHOULD BE DELETED: this is not a proper codemod', () => {
  // This test documents why this script should be removed from the codemod collection
  
  console.warn('RECOMMENDATION: This script should be DELETED from the codemod collection');
  console.warn('Reasons:');
  console.warn('  1. Hardcoded file path makes it useless for other files');
  console.warn('  2. Hardcoded import names make it non-generic');
  console.warn('  3. Line-based filtering is extremely brittle');
  console.warn('  4. No validation of actual import usage');
  console.warn('  5. No TypeScript syntax awareness');
  console.warn('  6. Cannot be reused across projects');
  console.warn('  7. Not parameterizable or configurable');
  console.warn('  8. No error handling or safety checks');
  
  // This is a one-time fix script, not a reusable codemod
  const input = `import { example } from './module';`;
  const { content: result, changes } = mockFixUnusedImports(input, "random/file.ts");
  
  expect(result).toBe(input);
  expect(changes).toBe(0);
  
  // A proper codemod would analyze imports and remove unused ones generically
  expect(typeof mockFixUnusedImports).toBe('function');
});

test('Fix unused imports PROPER CODEMOD WOULD: demonstrate what a real codemod should do', () => {
  console.warn('A PROPER unused import codemod would:');
  console.warn('  1. Accept file paths as parameters or process multiple files');
  console.warn('  2. Parse TypeScript AST to understand import syntax');
  console.warn('  3. Analyze actual symbol usage throughout the file');
  console.warn('  4. Detect unused imports automatically');
  console.warn('  5. Handle various import patterns (named, default, namespace, etc.)');
  console.warn('  6. Provide safety checks and validation');
  console.warn('  7. Be configurable and parameterizable');
  console.warn('  8. Work across different projects and file structures');
  console.warn('  9. Handle TypeScript-specific syntax correctly');
  console.warn('  10. Provide rollback capabilities');
  
  // This current script does NONE of these things
  const input = `import { used, unused } from './module'; console.log(used);`;
  const { content: result } = mockFixUnusedImports(input, "any/file.ts");
  
  // Current script would do nothing for this generic case
  expect(result).toBe(input);
  
  // A proper codemod would analyze and remove only 'unused'
  // expect(properCodemod(input)).toBe(`import { used } from './module'; console.log(used);`);
}); 
