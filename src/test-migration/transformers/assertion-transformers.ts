import { Node, SourceFile } from "ts-morph";
import { Transformer } from "./pipeline";

/**
 * Transformer for assertion patterns
 */
export class AssertionTransformer implements Transformer {
  patternId = "to-have-been-called";
  priority = 60;
  safetyLevel: "low" | "medium" | "high" = "medium";

  /**
   * Transform an assertion pattern
   *
   * @param text Original assertion text
   * @param node AST node for the assertion
   * @param sourceFile Source file containing the assertion
   * @returns Transformed assertion text
   */
  async transform(text: string, node: Node, sourceFile: SourceFile): Promise<string> {
    if (Node.isCallExpression(node)) {
      return this.transformAssertion(node, sourceFile);
    }
    return text;
  }

  /**
   * Transform an assertion call
   *
   * @param callExpr Call expression to transform
   * @param sourceFile Source file containing the call
   * @returns Transformed assertion text
   */
  private transformAssertion(callExpr: Node, sourceFile: SourceFile): string {
    if (Node.isCallExpression(callExpr)) {
      const text = callExpr.getText();

      // toHaveBeenCalled()
      if (text.includes(".toHaveBeenCalled()")) {
        // Extract the mock function name
        const mockMatch = text.match(/expect\((.*?)\)\.toHaveBeenCalled\(\)/);
        if (mockMatch) {
          const mockFn = mockMatch[1];
          return `expect(${mockFn}.mock.calls.length).toBeGreaterThan(0)`;
        }
      }

      // toHaveBeenCalledTimes(n)
      const timesMatch = text.match(/expect\((.*?)\)\.toHaveBeenCalledTimes\((\d+)\)/);
      if (timesMatch) {
        const mockFn = timesMatch[1];
        const times = timesMatch[2];
        return `expect(${mockFn}.mock.calls.length).toBe(${times})`;
      }

      // toHaveBeenCalledWith
      const withMatch = text.match(/expect\((.*?)\)\.toHaveBeenCalledWith\((.*)\)/);
      if (withMatch) {
        const mockFn = withMatch[1];
        const args = withMatch[2];
        // This one is more complex as we need to check the actual arguments
        // For medium safety level, we'll use a more cautious approach
        if (this.safetyLevel === "low") {
          return `expect(${mockFn}.mock.calls[0]).toEqual([${args}])`;
        } else {
          // For higher safety levels, provide a comment
          return `${text} // Needs manual conversion to: expect(${mockFn}.mock.calls[0]).toEqual([${args}])`;
        }
      }

      // expect.anything()
      if (text.includes("expect.anything()")) {
        if (this.safetyLevel === "low") {
          // In low safety, attempt to convert
          return text.replace(/expect\.anything\(\)/g, "expect.any(Object)");
        } else {
          // For higher safety, keep original but add comment
          return `${text} // Consider manually converting expect.anything() to more specific matcher`;
        }
      }

      // expect.any(Type)
      const anyMatch = text.match(/expect\.any\((.*?)\)/);
      if (anyMatch && this.safetyLevel === "low") {
        // In low safety, keep the same as Bun supports similar matcher
        return text;
      }
    }

    // Fall back to original text
    return callExpr.getText();
  }
}
