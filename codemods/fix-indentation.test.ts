/**
 * Test for ESLint Auto-Fix Codemod
 * 
 * Validates the codemod does ONLY what it claims:
 * - Only runs ESLint with --fix flag
 * - Only applies auto-fixable ESLint rules
 * - Does not modify code logic, only formatting and style
 * - Uses project's existing ESLint configuration
 * - Handles ESLint exit codes properly
 */

import { test, expect } from 'bun:test';
import { readFileSync } from 'fs';

// Read the actual codemod content to validate its behavior
const codemodContent = readFileSync('/Users/edobry/.local/state/minsky/sessions/task#178/codemods/fix-indentation.ts', 'utf8');

test('ESLint auto-fix codemod runs ONLY the correct ESLint command', () => {
  // Should contain exactly the right command
  expect(codemodContent).toContain('bun run lint --fix');
  
  // Should NOT contain any other potentially destructive commands
  expect(codemodContent).not.toContain('rm ');
  expect(codemodContent).not.toContain('git ');
  expect(codemodContent).not.toContain('npm ');
  expect(codemodContent).not.toContain('yarn ');
  expect(codemodContent).not.toContain('prettier ');
  expect(codemodContent).not.toContain('tsc ');
  expect(codemodContent).not.toContain('node ');
  
  // Should use execSync (not other execution methods)
  expect(codemodContent).toContain('execSync');
  expect(codemodContent).not.toContain('exec(');
  expect(codemodContent).not.toContain('spawn');
});

test('ESLint auto-fix uses only safe ESLint flags', () => {
  // Should use --fix flag (safe auto-fixable rules only)
  expect(codemodContent).toContain('--fix');
  
  // Should NOT use potentially dangerous flags
  expect(codemodContent).not.toContain('--fix-dry-run');
  expect(codemodContent).not.toContain('--fix-type');
  expect(codemodContent).not.toContain('--rules');
  expect(codemodContent).not.toContain('--config');
  expect(codemodContent).not.toContain('--ignore-path');
  expect(codemodContent).not.toContain('--no-eslintrc');
  
  // Should be exactly the safe command
  expect(codemodContent).toContain('"bun run lint --fix"');
});

test('ESLint auto-fix handles error cases properly', () => {
  // Should handle execSync errors (ESLint returns non-zero even when fixes applied)
  expect(codemodContent).toContain('try {');
  expect(codemodContent).toContain('} catch (error');
  
  // Should check for stdout/stderr to handle ESLint behavior
  expect(codemodContent).toContain('error.stdout');
  expect(codemodContent).toContain('error.stderr');
  
  // Should not crash on errors
  expect(codemodContent).toContain('console.log');
  expect(codemodContent).not.toContain('throw error');
  expect(codemodContent).not.toContain('process.exit');
});

test('ESLint auto-fix uses project configuration', () => {
  // Should use current working directory
  expect(codemodContent).toContain('process.cwd()');
  
  // Should use project's lint script (respects package.json)
  expect(codemodContent).toContain('bun run lint');
  
  // Should NOT override project configuration
  expect(codemodContent).not.toContain('--config');
  expect(codemodContent).not.toContain('--rules');
  expect(codemodContent).not.toContain('--ignore-pattern');
});

test('ESLint auto-fix does NOT modify files directly', () => {
  // Should only run ESLint, not modify files directly
  expect(codemodContent).not.toContain('writeFileSync');
  expect(codemodContent).not.toContain('writeFile');
  expect(codemodContent).not.toContain('readFileSync');
  expect(codemodContent).not.toContain('readFile');
  expect(codemodContent).not.toContain('unlinkSync');
  expect(codemodContent).not.toContain('unlink');
  
  // Should rely on ESLint to do the file modifications
  expect(codemodContent).toContain('execSync');
  expect(codemodContent).toContain('--fix');
});

test('ESLint auto-fix provides appropriate logging', () => {
  // Should provide informative console output
  expect(codemodContent).toContain('console.log');
  expect(codemodContent).toContain('Running ESLint');
  expect(codemodContent).toContain('--fix');
  
  // Should log both success and error cases
  expect(codemodContent).toContain('completed successfully');
  expect(codemodContent).toContain('ESLint stderr');
  expect(codemodContent).toContain('ESLint --fix applied fixes');
  
  // Should not use other logging methods
  expect(codemodContent).not.toContain('console.error');
  expect(codemodContent).not.toContain('console.warn');
});

test('ESLint auto-fix has proper imports and dependencies', () => {
  // Should import only what it needs
  expect(codemodContent).toContain('import { execSync } from "child_process"');
  
  // Should NOT import file system modules (ESLint handles files)
  expect(codemodContent).not.toContain('from "fs"');
  expect(codemodContent).not.toContain('from "path"');
  expect(codemodContent).not.toContain('from "glob"');
  
  // Should be a focused, single-purpose codemod
  const importLines = codemodContent.split('\n').filter(line => line.startsWith('import'));
  expect(importLines.length).toBe(1);
}); 
