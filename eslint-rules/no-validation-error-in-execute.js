/**
 * ESLint Rule: no-validation-error-in-execute
 *
 * Disallow throwing ValidationError inside execute() methods.
 * Validation logic should live in the validate() method per ADR-004.
 *
 * @see ADR-004 — Validate→Execute Command Pipeline
 */
export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow throwing ValidationError inside execute() methods (ADR-004)",
    },
    messages: {
      noValidationErrorInExecute:
        "ValidationError should not be thrown inside execute() — move validation to the validate() method (ADR-004).",
    },
    schema: [],
  },
  create(context) {
    let insideExecute = false;

    return {
      "Property[key.name='execute'] > ArrowFunctionExpression"() {
        insideExecute = true;
      },
      "Property[key.name='execute'] > ArrowFunctionExpression:exit"() {
        insideExecute = false;
      },
      "Property[key.name='execute'] > FunctionExpression"() {
        insideExecute = true;
      },
      "Property[key.name='execute'] > FunctionExpression:exit"() {
        insideExecute = false;
      },
      ThrowStatement(node) {
        if (!insideExecute) return;
        // Check if throwing ValidationError
        const arg = node.argument;
        if (
          arg &&
          arg.type === "NewExpression" &&
          arg.callee.type === "Identifier" &&
          arg.callee.name === "ValidationError"
        ) {
          context.report({ node, messageId: "noValidationErrorInExecute" });
        }
      },
    };
  },
};
