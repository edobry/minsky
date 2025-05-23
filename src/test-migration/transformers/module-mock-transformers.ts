import { Node, SourceFile } from "ts-morph";
import { Transformer } from "./pipeline";

/**
 * Base class for module mock transformers
 */
abstract class ModuleMockTransformer implements Transformer {
  abstract patternId: string;
  priority = 70; // Medium priority
  safetyLevel: "low" | "medium" | "high" = "low"; // More risky transformation

  /**
   * Transform a module mock
   *
   * @param text Original module mock text
   * @param node AST node for the module mock
   * @param sourceFile Source file containing the module mock
   * @returns Transformed module mock text
   */
  async transform(text: string, node: Node, sourceFile: SourceFile): Promise<string> {
    if (Node.isCallExpression(node)) {
      return this.transformModuleMock(node, sourceFile);
    }
    return text;
  }

  /**
   * Transform a module mock call expression
   *
   * @param callExpr Call expression to transform
   * @param sourceFile Source file containing the call
   * @returns Transformed module mock text
   */
  protected abstract transformModuleMock(callExpr: Node, sourceFile: SourceFile): string;
}

/**
 * Transformer for Jest module mocks
 */
export class JestModuleMockTransformer extends ModuleMockTransformer {
  patternId = "jest-mock-module";

  /**
   * Transform a Jest module mock
   *
   * @param callExpr Call expression to transform
   * @param sourceFile Source file containing the call
   * @returns Transformed module mock text
   */
  protected transformModuleMock(callExpr: Node, sourceFile: SourceFile): string {
    if (Node.isCallExpression(callExpr)) {
      const text = callExpr.getText();

      // Simple jest.mock(path)
      const pathMatch = text.match(/jest\.mock\(\s*["'](.*?)["']\s*\)/);
      if (pathMatch) {
        const modulePath = pathMatch[1];
        return `mock.module("${modulePath}", () => ({}));`;
      }

      // jest.mock with factory
      const factoryMatch = text.match(
        /jest\.mock\(\s*["'](.*?)["']\s*,\s*\(\)\s*=>\s*\{(.*)\}\s*\)/s
      );
      if (factoryMatch) {
        const modulePath = factoryMatch[1];
        const factoryBody = factoryMatch[2];
        return `mock.module("${modulePath}", () => {${factoryBody}});`;
      }

      // jest.mock with object
      const objectMatch = text.match(
        /jest\.mock\(\s*["'](.*?)["']\s*,\s*\(\)\s*=>\s*(\{.*\})\s*\)/s
      );
      if (objectMatch) {
        const modulePath = objectMatch[1];
        const mockObject = objectMatch[2];
        return `mock.module("${modulePath}", () => ${mockObject});`;
      }
    }

    // Fall back to original text
    return callExpr.getText();
  }
}

/**
 * Transformer for Vitest module mocks
 */
export class ViModuleMockTransformer extends ModuleMockTransformer {
  patternId = "vi-mock-module";

  /**
   * Transform a Vitest module mock
   *
   * @param callExpr Call expression to transform
   * @param sourceFile Source file containing the call
   * @returns Transformed module mock text
   */
  protected transformModuleMock(callExpr: Node, sourceFile: SourceFile): string {
    if (Node.isCallExpression(callExpr)) {
      const text = callExpr.getText();

      // Simple vi.mock(path)
      const pathMatch = text.match(/vi\.mock\(\s*["'](.*?)["']\s*\)/);
      if (pathMatch) {
        const modulePath = pathMatch[1];
        return `mock.module("${modulePath}", () => ({}));`;
      }

      // vi.mock with factory
      const factoryMatch = text.match(
        /vi\.mock\(\s*["'](.*?)["']\s*,\s*\(\)\s*=>\s*\{(.*)\}\s*\)/s
      );
      if (factoryMatch) {
        const modulePath = factoryMatch[1];
        const factoryBody = factoryMatch[2];
        return `mock.module("${modulePath}", () => {${factoryBody}});`;
      }

      // vi.mock with object
      const objectMatch = text.match(/vi\.mock\(\s*["'](.*?)["']\s*,\s*\(\)\s*=>\s*(\{.*\})\s*\)/s);
      if (objectMatch) {
        const modulePath = objectMatch[1];
        const mockObject = objectMatch[2];
        return `mock.module("${modulePath}", () => ${mockObject});`;
      }
    }

    // Fall back to original text
    return callExpr.getText();
  }
}
