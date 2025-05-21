import { Node, SourceFile } from "ts-morph";
import { Transformer } from "./pipeline";

/**
 * Base class for mock function transformers
 */
abstract class MockFunctionTransformer implements Transformer {
  abstract patternId: string;
  priority = 80; // High priority but lower than imports
  safetyLevel: 'low' | 'medium' | 'high' = 'medium'; // Medium safety level
  
  /**
   * Transform a mock function
   * 
   * @param text Original mock function text
   * @param node AST node for the mock function
   * @param sourceFile Source file containing the mock function
   * @returns Transformed mock function text
   */
  async transform(text: string, node: Node, sourceFile: SourceFile): Promise<string> {
    if (Node.isCallExpression(node)) {
      return this.transformMockFunction(node, sourceFile);
    }
    return text;
  }
  
  /**
   * Transform a mock function call expression
   * 
   * @param callExpr Call expression to transform
   * @param sourceFile Source file containing the call
   * @returns Transformed mock function text
   */
  protected abstract transformMockFunction(callExpr: Node, sourceFile: SourceFile): string;
}

/**
 * Transformer for Jest mock functions
 */
export class JestMockFunctionTransformer extends MockFunctionTransformer {
  patternId = 'jest-fn';
  
  /**
   * Transform a Jest mock function
   * 
   * @param callExpr Call expression to transform
   * @param sourceFile Source file containing the call
   * @returns Transformed mock function text
   */
  protected transformMockFunction(callExpr: Node, sourceFile: SourceFile): string {
    if (Node.isCallExpression(callExpr)) {
      const text = callExpr.getText();
      
      // Simple jest.fn()
      if (text.match(/jest\.fn\s*\(\s*\)/)) {
        return "mock(() => {})";
      }
      
      // jest.fn() with implementation
      const implMatch = text.match(/jest\.fn\s*\(\s*\(\s*\)\s*=>\s*\{(.*?)\}\s*\)/s);
      if (implMatch) {
        const impl = implMatch[1];
        return `mock(() => {${impl}})`;
      }
      
      // jest.fn() with return value
      const returnMatch = text.match(/jest\.fn\s*\(\s*\(\s*\)\s*=>\s*(.*?)\s*\)/s);
      if (returnMatch) {
        const returnValue = returnMatch[1];
        return `mock(() => ${returnValue})`;
      }
      
      // mockImplementation
      const mockImplMatch = text.match(/jest\.fn\(\)\.mockImplementation\s*\(\s*\(\s*\)\s*=>\s*\{(.*?)\}\s*\)/s);
      if (mockImplMatch) {
        const impl = mockImplMatch[1];
        return `mock(() => {${impl}})`;
      }
      
      // mockReturnValue
      const mockReturnMatch = text.match(/jest\.fn\(\)\.mockReturnValue\s*\(\s*(.*?)\s*\)/s);
      if (mockReturnMatch) {
        const returnValue = mockReturnMatch[1];
        return `mock(() => ${returnValue})`;
      }
    }
    
    // Fall back to original text
    return callExpr.getText();
  }
}

/**
 * Transformer for Vitest mock functions
 */
export class ViMockFunctionTransformer extends MockFunctionTransformer {
  patternId = 'vi-fn';
  
  /**
   * Transform a Vitest mock function
   * 
   * @param callExpr Call expression to transform
   * @param sourceFile Source file containing the call
   * @returns Transformed mock function text
   */
  protected transformMockFunction(callExpr: Node, sourceFile: SourceFile): string {
    if (Node.isCallExpression(callExpr)) {
      const text = callExpr.getText();
      
      // Simple vi.fn()
      if (text.match(/vi\.fn\s*\(\s*\)/)) {
        return "mock(() => {})";
      }
      
      // vi.fn() with implementation
      const implMatch = text.match(/vi\.fn\s*\(\s*\(\s*\)\s*=>\s*\{(.*?)\}\s*\)/s);
      if (implMatch) {
        const impl = implMatch[1];
        return `mock(() => {${impl}})`;
      }
      
      // vi.fn() with return value
      const returnMatch = text.match(/vi\.fn\s*\(\s*\(\s*\)\s*=>\s*(.*?)\s*\)/s);
      if (returnMatch) {
        const returnValue = returnMatch[1];
        return `mock(() => ${returnValue})`;
      }
      
      // mockImplementation
      const mockImplMatch = text.match(/vi\.fn\(\)\.mockImplementation\s*\(\s*\(\s*\)\s*=>\s*\{(.*?)\}\s*\)/s);
      if (mockImplMatch) {
        const impl = mockImplMatch[1];
        return `mock(() => {${impl}})`;
      }
      
      // mockReturnValue
      const mockReturnMatch = text.match(/vi\.fn\(\)\.mockReturnValue\s*\(\s*(.*?)\s*\)/s);
      if (mockReturnMatch) {
        const returnValue = mockReturnMatch[1];
        return `mock(() => ${returnValue})`;
      }
    }
    
    // Fall back to original text
    return callExpr.getText();
  }
}

/**
 * Transformer for mock function configuration methods
 */
export class MockConfigurationTransformer implements Transformer {
  patternId = 'mock-configuration';
  priority = 75;
  safetyLevel: 'low' | 'medium' | 'high' = 'medium';
  
  /**
   * Transform a mock configuration method call
   * 
   * @param text Original method call text
   * @param node AST node for the method call
   * @param sourceFile Source file containing the call
   * @returns Transformed method call text
   */
  async transform(text: string, node: Node, sourceFile: SourceFile): Promise<string> {
    if (Node.isCallExpression(node)) {
      const callText = node.getText();
      
      // mockReset
      if (callText.includes('.mockReset()')) {
        // Extract the mock function name
        const mockMatch = callText.match(/(.*?)\.mockReset\(\)/);
        if (mockMatch) {
          const mockFn = mockMatch[1];
          return `${mockFn}.mock.resetCalls()`;
        }
      }
      
      // mockClear
      if (callText.includes('.mockClear()')) {
        // Extract the mock function name
        const mockMatch = callText.match(/(.*?)\.mockClear\(\)/);
        if (mockMatch) {
          const mockFn = mockMatch[1];
          return `${mockFn}.mock.resetCalls()`;
        }
      }
    }
    
    return text;
  }
} 
