/**
 * Boundary Validation Test for comprehensive-underscore-fix.ts
 * 
 * PURPOSE: Test whether the codemod does ONLY what it claims to do:
 * - Fix underscore mismatches in variable usage vs declaration
 * - NOT break working code that intentionally uses underscores
 * - NOT modify code that doesn't have underscore issues
 * 
 * METHODOLOGY: Runtime transformation testing with positive and negative constraints
 */

import { execSync } from 'child_process';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

describe('Boundary Validation: comprehensive-underscore-fix.ts', () => {
  const testDir = '/tmp/codemod-test-comprehensive-underscore';
  
  beforeAll(() => {
    // Create test directory
    execSync(`mkdir -p ${testDir}/src`);
  });

  afterAll(() => {
    // Clean up test directory
    execSync(`rm -rf ${testDir}`);
  });

  /**
   * POSITIVE CONSTRAINT: Should fix legitimate underscore mismatches
   */
  describe('Positive Constraints: Should Fix', () => {
    test('should fix declaration vs usage mismatches', () => {
      const testFile = join(testDir, 'src/underscore-mismatch.ts');
      const input = `
// Case 1: Declaration has underscore, usage doesn't
const _result = getData();
console.log(result.value);

// Case 2: Variable assignment mismatch
const _item = items[0];
if (item.valid) {
  return item.name;
}

// Case 3: Function parameter mismatch
function process(_data: string) {
  return data.toUpperCase();
}
      `;
      
      writeFileSync(testFile, input);
      
      // Run the codemod
      const codemodPath = join(process.cwd(), 'codemods/comprehensive-underscore-fix.ts');
      const result = execSync(`cd ${testDir} && bun ${codemodPath}`, { encoding: 'utf8' });
      
      const output = readFileSync(testFile, 'utf8');
      
      // Should fix declaration to match usage
      expect(output).toContain('const result = getData()');
      expect(output).toContain('const item = items[0]');
      expect(output).toContain('function process(data: string)');
      expect(output).toContain('return data.toUpperCase()');
      
      // Should report changes
      expect(result).toContain('changes');
    });

    test('should fix complex usage patterns', () => {
      const testFile = join(testDir, 'src/usage-patterns.ts');
      const input = `
const _command = getCommand();
const _response = await fetch(url);

// Various usage patterns that should be fixed
if (_command.type === 'test') {
  return _command.execute();
}

const result = _response.json();
console.log(\`Response: \${_response.status}\`);
      `;
      
      writeFileSync(testFile, input);
      
      const codemodPath = join(process.cwd(), 'codemods/comprehensive-underscore-fix.ts');
      execSync(`cd ${testDir} && bun ${codemodPath}`, { encoding: 'utf8' });
      
      const output = readFileSync(testFile, 'utf8');
      
      // Should fix usage patterns
      expect(output).toContain('if (command.type === \'test\')');
      expect(output).toContain('return command.execute()');
      expect(output).toContain('${response.status}');
    });
  });

  /**
   * NEGATIVE CONSTRAINT: Should NOT modify working code
   */
  describe('Negative Constraints: Should NOT Modify', () => {
    test('should not modify code without underscore issues', () => {
      const testFile = join(testDir, 'src/no-issues.ts');
      const input = `
// Correct code without underscore issues
const result = getData();
console.log(result.value);

const item = items[0];
if (item.valid) {
  return item.name;
}

function process(data: string) {
  return data.toUpperCase();
}

// This should remain unchanged
const normalVariable = 'test';
const anotherVar = normalVariable.toUpperCase();
      `;
      
      writeFileSync(testFile, input);
      const originalContent = readFileSync(testFile, 'utf8');
      
      const codemodPath = join(process.cwd(), 'codemods/comprehensive-underscore-fix.ts');
      execSync(`cd ${testDir} && bun ${codemodPath}`, { encoding: 'utf8' });
      
      const output = readFileSync(testFile, 'utf8');
      
      // Should remain completely unchanged
      expect(output).toBe(originalContent);
    });

    test('should not modify intentional underscore prefixes', () => {
      const testFile = join(testDir, 'src/intentional-underscores.ts');
      const input = `
// Intentional underscore prefixes (unused parameters)
function handler(_event: Event, data: string) {
  return data.toUpperCase();
}

// Private-style naming convention
class MyClass {
  private _internal = 'private';
  
  public method(_unused: string) {
    return this._internal;
  }
}

// Underscore as naming convention
const _config = {
  _debug: true,
  _version: '1.0.0'
};
      `;
      
      writeFileSync(testFile, input);
      const originalContent = readFileSync(testFile, 'utf8');
      
      const codemodPath = join(process.cwd(), 'codemods/comprehensive-underscore-fix.ts');
      execSync(`cd ${testDir} && bun ${codemodPath}`, { encoding: 'utf8' });
      
      const output = readFileSync(testFile, 'utf8');
      
      // Should preserve intentional underscore usage
      expect(output).toBe(originalContent);
    });

    test('should not break syntax or create invalid code', () => {
      const testFile = join(testDir, 'src/syntax-validation.ts');
      const input = `
// Complex code that might confuse regex patterns
const _result = complex.chain()
  .filter(item => item.valid)
  .map(item => item.transform())
  .reduce((acc, item) => acc + item, 0);

// Use result in complex expression
const final = result > 0 ? result * 2 : 0;

// Template literals and other complex patterns
const message = \`The result is: \${result}\`;
      `;
      
      writeFileSync(testFile, input);
      
      const codemodPath = join(process.cwd(), 'codemods/comprehensive-underscore-fix.ts');
      execSync(`cd ${testDir} && bun ${codemodPath}`, { encoding: 'utf8' });
      
      const output = readFileSync(testFile, 'utf8');
      
             // Should be valid TypeScript
       const tsCheckFile = join(testDir, 'tsconfig.json');
       writeFileSync(tsCheckFile, JSON.stringify({
         compilerOptions: {
           target: 'es2020',
           module: 'commonjs',
           strict: true,
           noEmit: true
         }
       }), 'utf8');
      
      // Should compile without errors
      expect(() => {
        execSync(`cd ${testDir} && npx tsc --noEmit`, { encoding: 'utf8' });
      }).not.toThrow();
    });
  });

  /**
   * BOUNDARY VIOLATION DETECTION: Test problematic patterns
   */
  describe('Boundary Violation Detection', () => {
    test('should detect overly broad regex patterns', () => {
      const testFile = join(testDir, 'src/edge-cases.ts');
      const input = `
// Edge case: underscore in string literal
const message = "This has _underscore in string";
const code = 'const _variable = value;';

// Edge case: underscore in comments
// This _comment has underscore
/* Another _comment */

// Edge case: underscore in object keys
const obj = {
  '_key': 'value',
  normal: 'value'
};
      `;
      
      writeFileSync(testFile, input);
      const originalContent = readFileSync(testFile, 'utf8');
      
      const codemodPath = join(process.cwd(), 'codemods/comprehensive-underscore-fix.ts');
      execSync(`cd ${testDir} && bun ${codemodPath}`, { encoding: 'utf8' });
      
      const output = readFileSync(testFile, 'utf8');
      
      // Should NOT modify strings, comments, or object keys
      expect(output).toContain('"This has _underscore in string"');
      expect(output).toContain('const _variable = value;');
      expect(output).toContain('// This _comment has underscore');
      expect(output).toContain('/* Another _comment */');
      expect(output).toContain("'_key': 'value'");
      
      // If any of these are modified, the codemod has boundary violations
      if (output !== originalContent) {
        console.warn('⚠️  BOUNDARY VIOLATION: Codemod modified strings, comments, or object keys');
      }
    });

    test('should not create infinite replacement loops', () => {
      const testFile = join(testDir, 'src/loop-detection.ts');
      const input = `
// Pattern that could cause infinite loops
const _test = 'value';
const __test = 'value';
const ___test = 'value';
      `;
      
      writeFileSync(testFile, input);
      
      const codemodPath = join(process.cwd(), 'codemods/comprehensive-underscore-fix.ts');
      
      // Run codemod with timeout to detect infinite loops
      const startTime = Date.now();
      execSync(`cd ${testDir} && timeout 30s bun ${codemodPath}`, { encoding: 'utf8' });
      const endTime = Date.now();
      
      // Should complete in reasonable time (< 10 seconds)
      expect(endTime - startTime).toBeLessThan(10000);
    });
  });

  /**
   * PERFORMANCE AND SAFETY VALIDATION
   */
  describe('Performance and Safety', () => {
    test('should handle large files efficiently', () => {
      const testFile = join(testDir, 'src/large-file.ts');
      
      // Generate large file with mixed patterns
      const lines = [];
      for (let i = 0; i < 1000; i++) {
        lines.push(`const _var${i} = getValue(${i});`);
        lines.push(`console.log(var${i});`);
      }
      
      writeFileSync(testFile, lines.join('\n'));
      
      const codemodPath = join(process.cwd(), 'codemods/comprehensive-underscore-fix.ts');
      
      const startTime = Date.now();
      execSync(`cd ${testDir} && bun ${codemodPath}`, { encoding: 'utf8' });
      const endTime = Date.now();
      
      // Should complete in reasonable time
      expect(endTime - startTime).toBeLessThan(30000); // 30 seconds max
    });

    test('should report accurate change counts', () => {
      const testFile = join(testDir, 'src/count-validation.ts');
      const input = `
const _a = 1;
const _b = 2;
const _c = 3;
console.log(a + b + c);
      `;
      
      writeFileSync(testFile, input);
      
      const codemodPath = join(process.cwd(), 'codemods/comprehensive-underscore-fix.ts');
      const result = execSync(`cd ${testDir} && bun ${codemodPath}`, { encoding: 'utf8' });
      
      const output = readFileSync(testFile, 'utf8');
      
      // Should report changes correctly
      expect(result).toMatch(/\d+ changes/);
      
      // Should actually fix the expected number of issues
      expect(output).toContain('const a = 1');
      expect(output).toContain('const b = 2');
      expect(output).toContain('const c = 3');
    });
  });
}); 
