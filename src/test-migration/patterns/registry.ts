import { Node } from "ts-morph";

/**
 * Pattern types that can be identified in test files
 */
export type PatternType = 'import' | 'mock-function' | 'module-mock' | 'assertion' | 'lifecycle';

/**
 * A pattern that can be matched in test files
 */
export interface Pattern {
  /**
   * Unique identifier for the pattern
   */
  id: string;
  
  /**
   * Type of pattern
   */
  type: PatternType;
  
  /**
   * Description of the pattern
   */
  description: string;
  
  /**
   * Function to match the pattern
   * 
   * @param text Source text to match against
   * @param node AST node to match against
   * @returns True if the pattern matches, false otherwise
   */
  matcher: (text: string, node: Node) => boolean;
  
  /**
   * Example of the pattern before transformation
   */
  beforeExample: string;
  
  /**
   * Example of the pattern after transformation
   */
  afterExample: string;
  
  /**
   * Migration complexity
   */
  complexity: 'simple' | 'moderate' | 'complex';
}

/**
 * Result of matching a pattern
 */
export interface MatchedPattern {
  /**
   * Identifier of the matched pattern
   */
  id: string;
  
  /**
   * Type of the matched pattern
   */
  type: PatternType | string;
  
  /**
   * Location of the match (start-end)
   */
  location: string;
  
  /**
   * The matched text
   */
  text: string;
}

/**
 * Registry of patterns to identify in test files
 */
export class PatternRegistry {
  private patterns: Map<string, Pattern> = new Map();
  
  /**
   * Register a pattern
   * 
   * @param pattern Pattern to register
   */
  registerPattern(pattern: Pattern): void {
    this.patterns.set(pattern.id, pattern);
  }
  
  /**
   * Get all patterns of a specific type
   * 
   * @param type Type of patterns to get
   * @returns Array of patterns
   */
  getPatterns(type?: PatternType): Pattern[] {
    const patterns = Array.from(this.patterns.values());
    return type ? patterns.filter(p => p.type === type) : patterns;
  }
  
  /**
   * Get a pattern by ID
   * 
   * @param id Pattern ID
   * @returns Pattern or undefined
   */
  getPattern(id: string): Pattern | undefined {
    return this.patterns.get(id);
  }
  
  /**
   * Register all default patterns
   */
  registerDefaultPatterns(): void {
    // Import patterns
    this.registerJestImportPatterns();
    
    // Mock function patterns
    this.registerMockFunctionPatterns();
    
    // Module mock patterns
    this.registerModuleMockPatterns();
    
    // Assertion patterns
    this.registerAssertionPatterns();
    
    // Lifecycle patterns
    this.registerLifecyclePatterns();
  }
  
  /**
   * Register patterns for Jest/Vitest imports
   */
  private registerJestImportPatterns(): void {
    // Jest import pattern
    this.registerPattern({
      id: 'jest-import',
      type: 'import',
      description: 'Import statement for Jest globals',
      matcher: (text, node) => {
        if (Node.isImportDeclaration(node)) {
          const moduleSpecifier = node.getModuleSpecifierValue();
          return moduleSpecifier === '@jest/globals';
        }
        return false;
      },
      beforeExample: "import { jest } from '@jest/globals';",
      afterExample: "// No import needed for Bun tests",
      complexity: 'simple'
    });
    
    // Vitest import pattern
    this.registerPattern({
      id: 'vitest-import',
      type: 'import',
      description: 'Import statement for Vitest',
      matcher: (text, node) => {
        if (Node.isImportDeclaration(node)) {
          const moduleSpecifier = node.getModuleSpecifierValue();
          return moduleSpecifier === 'vitest';
        }
        return false;
      },
      beforeExample: "import { vi } from 'vitest';",
      afterExample: "// No import needed for Bun tests",
      complexity: 'simple'
    });
  }
  
  /**
   * Register patterns for mock functions
   */
  private registerMockFunctionPatterns(): void {
    // Jest.fn()
    this.registerPattern({
      id: 'jest-fn',
      type: 'mock-function',
      description: 'Jest mock function creation',
      matcher: (text, node) => {
        return text.includes('jest.fn(') || text.match(/jest\.fn\s*\(/) !== null;
      },
      beforeExample: "const mockFn = jest.fn();",
      afterExample: "const mockFn = mock(() => {});",
      complexity: 'moderate'
    });
    
    // Vi.fn()
    this.registerPattern({
      id: 'vi-fn',
      type: 'mock-function',
      description: 'Vitest mock function creation',
      matcher: (text, node) => {
        return text.includes('vi.fn(') || text.match(/vi\.fn\s*\(/) !== null;
      },
      beforeExample: "const mockFn = vi.fn();",
      afterExample: "const mockFn = mock(() => {});",
      complexity: 'moderate'
    });
    
    // mockImplementation
    this.registerPattern({
      id: 'mock-implementation',
      type: 'mock-function',
      description: 'Mock implementation',
      matcher: (text, node) => {
        return text.includes('.mockImplementation(') || text.match(/\.mockImplementation\s*\(/) !== null;
      },
      beforeExample: "const mockFn = jest.fn().mockImplementation(() => 'mocked');",
      afterExample: "const mockFn = mock(() => 'mocked');",
      complexity: 'moderate'
    });
    
    // mockReturnValue
    this.registerPattern({
      id: 'mock-return-value',
      type: 'mock-function',
      description: 'Mock return value',
      matcher: (text, node) => {
        return text.includes('.mockReturnValue(') || text.match(/\.mockReturnValue\s*\(/) !== null;
      },
      beforeExample: "const mockFn = jest.fn().mockReturnValue('value');",
      afterExample: "const mockFn = mock(() => 'value');",
      complexity: 'moderate'
    });
    
    // mockReset and mockClear
    this.registerPattern({
      id: 'mock-reset-clear',
      type: 'mock-function',
      description: 'Mock reset or clear',
      matcher: (text, node) => {
        return text.includes('.mockReset()') || text.includes('.mockClear()');
      },
      beforeExample: "mockFn.mockReset();",
      afterExample: "mockFn.mock.resetCalls();",
      complexity: 'complex'
    });
  }
  
  /**
   * Register patterns for module mocks
   */
  private registerModuleMockPatterns(): void {
    // jest.mock
    this.registerPattern({
      id: 'jest-mock-module',
      type: 'module-mock',
      description: 'Jest module mock',
      matcher: (text, node) => {
        return text.includes('jest.mock(') || text.match(/jest\.mock\s*\(/) !== null;
      },
      beforeExample: "jest.mock('../path/to/module');",
      afterExample: "mock.module('../path/to/module', () => ({ /* mocked exports */ }));",
      complexity: 'complex'
    });
    
    // vi.mock
    this.registerPattern({
      id: 'vi-mock-module',
      type: 'module-mock',
      description: 'Vitest module mock',
      matcher: (text, node) => {
        return text.includes('vi.mock(') || text.match(/vi\.mock\s*\(/) !== null;
      },
      beforeExample: "vi.mock('../path/to/module');",
      afterExample: "mock.module('../path/to/module', () => ({ /* mocked exports */ }));",
      complexity: 'complex'
    });
  }
  
  /**
   * Register patterns for assertions
   */
  private registerAssertionPatterns(): void {
    // toHaveBeenCalled
    this.registerPattern({
      id: 'to-have-been-called',
      type: 'assertion',
      description: 'Assertion for mock function calls',
      matcher: (text, node) => {
        return text.includes('.toHaveBeenCalled()');
      },
      beforeExample: "expect(mockFn).toHaveBeenCalled();",
      afterExample: "expect(mockFn.mock.calls.length).toBeGreaterThan(0);",
      complexity: 'moderate'
    });
    
    // toHaveBeenCalledTimes
    this.registerPattern({
      id: 'to-have-been-called-times',
      type: 'assertion',
      description: 'Assertion for mock function call count',
      matcher: (text, node) => {
        return text.includes('.toHaveBeenCalledTimes(');
      },
      beforeExample: "expect(mockFn).toHaveBeenCalledTimes(2);",
      afterExample: "expect(mockFn.mock.calls.length).toBe(2);",
      complexity: 'moderate'
    });
    
    // expect.anything()
    this.registerPattern({
      id: 'expect-anything',
      type: 'assertion',
      description: 'Asymmetric matcher for anything',
      matcher: (text, node) => {
        return text.includes('expect.anything()');
      },
      beforeExample: "expect(value).toEqual(expect.anything());",
      afterExample: "// Use compatibility layer or replace with more specific assertion",
      complexity: 'complex'
    });
    
    // expect.any()
    this.registerPattern({
      id: 'expect-any',
      type: 'assertion',
      description: 'Asymmetric matcher for type',
      matcher: (text, node) => {
        return text.includes('expect.any(');
      },
      beforeExample: "expect(value).toEqual(expect.any(String));",
      afterExample: "// Use compatibility layer or replace with more specific assertion",
      complexity: 'complex'
    });
  }
  
  /**
   * Register patterns for lifecycle hooks
   */
  private registerLifecyclePatterns(): void {
    // These typically don't need transformation as Bun uses the same hooks
    // But we track them for completeness
    
    // beforeEach
    this.registerPattern({
      id: 'before-each',
      type: 'lifecycle',
      description: 'beforeEach hook',
      matcher: (text, node) => {
        if (Node.isCallExpression(node)) {
          const expression = node.getExpression();
          return Node.isIdentifier(expression) && expression.getText() === 'beforeEach';
        }
        return false;
      },
      beforeExample: "beforeEach(() => { /* setup */ });",
      afterExample: "beforeEach(() => { /* setup */ });",
      complexity: 'simple'
    });
    
    // afterEach
    this.registerPattern({
      id: 'after-each',
      type: 'lifecycle',
      description: 'afterEach hook',
      matcher: (text, node) => {
        if (Node.isCallExpression(node)) {
          const expression = node.getExpression();
          return Node.isIdentifier(expression) && expression.getText() === 'afterEach';
        }
        return false;
      },
      beforeExample: "afterEach(() => { /* teardown */ });",
      afterExample: "afterEach(() => { /* teardown */ });",
      complexity: 'simple'
    });
  }
} 
