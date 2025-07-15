/**
 * ESLint rule to prevent excessive use of 'as unknown' type assertions
 *
 * This rule detects dangerous patterns of 'as unknown' assertions that mask real type errors
 * and reduce TypeScript's effectiveness. Based on the analysis from task #280, it identifies
 * patterns that can typically be fixed with proper typing instead of assertions.
 *
 * The rule categorizes assertions by risk level:
 * - ERROR: Critical patterns that should never be used
 * - WARN: High-risk patterns that usually indicate a typing issue
 * - INFO: Medium-risk patterns that may be acceptable in some contexts
 */

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Prevent excessive use of 'as unknown' type assertions that mask real type errors",
      category: "TypeScript",
      recommended: true,
    },
    fixable: "code",
    schema: [
      {
        type: "object",
        properties: {
          allowInTests: {
            type: "boolean",
            default: false,
          },
          allowedPatterns: {
            type: "array",
            items: {
              type: "string",
            },
            default: [],
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      criticalAsUnknown: "Critical: 'as unknown' assertion in {{context}} masks real type errors. {{suggestion}}",
      dangerousAsUnknown: "Dangerous: 'as unknown' assertion on {{context}} likely indicates a typing issue. {{suggestion}}",
      riskAsUnknown: "Risky: 'as unknown' assertion on {{context}} may be unnecessary. {{suggestion}}",
      returnAsUnknown: "Never cast return values to 'as unknown'. Return proper types instead.",
      nullAsUnknown: "Don't cast null/undefined to 'as unknown'. Use proper null checks instead.",
      propertyAsUnknown: "Don't cast property access to 'as unknown'. Use proper type definitions instead.",
    },
  },

  create(context) {
    const options = context.options[0] || {};
    const allowInTests = options.allowInTests || false;
    const allowedPatterns = options.allowedPatterns || [];

    // Check if we're in a test file
    const filename = context.getFilename();
    const isTestFile = /\.(test|spec)\.ts$/.test(filename) || /\/__tests__\//.test(filename);

    function isAllowedPattern(text) {
      return allowedPatterns.some(pattern => {
        const regex = new RegExp(pattern);
        return regex.test(text);
      });
    }

    function analyzeAsUnknownPattern(node) {
      const sourceCode = context.getSourceCode();
      const expressionText = sourceCode.getText(node.expression);
      const fullText = sourceCode.getText(node);

      // Skip if this is an allowed pattern
      if (isAllowedPattern(fullText)) {
        return null;
      }

      // Critical patterns (ERROR level)
      if (node.parent.type === "ReturnStatement") {
        return {
          level: "error",
          messageId: "returnAsUnknown",
          context: "return statement",
          suggestion: "Return proper types instead of casting to unknown",
        };
      }

      // Null/undefined patterns (ERROR level)
      if (expressionText === "null" || expressionText === "undefined") {
        return {
          level: "error",
          messageId: "nullAsUnknown",
          context: expressionText,
          suggestion: "Use proper null checks instead of casting to unknown",
        };
      }

      // Dangerous patterns (WARN level)

      // Property access patterns - these usually indicate missing types
      if (node.parent.type === "MemberExpression" && node.parent.object === node) {
        const propertyName = node.parent.property.name ||
                            (node.parent.property.type === "Literal" ? node.parent.property.value : "property");

        return {
          level: "warn",
          messageId: "propertyAsUnknown",
          context: `property access (.${propertyName})`,
          suggestion: "Define proper types instead of casting to unknown",
        };
      }

      // Array/object method calls
      if (node.parent.type === "CallExpression" && node.parent.callee.type === "MemberExpression" &&
          node.parent.callee.object === node) {
        const methodName = node.parent.callee.property.name || "method";

        return {
          level: "warn",
          messageId: "dangerousAsUnknown",
          context: `method call (.${methodName}())`,
          suggestion: "Use proper typing instead of casting to unknown",
        };
      }

      // State/session property patterns
      if (expressionText.includes("state") || expressionText.includes("session") ||
          expressionText.includes("config") || expressionText.includes("options")) {
        return {
          level: "warn",
          messageId: "dangerousAsUnknown",
          context: `${expressionText} object`,
          suggestion: "Define proper interfaces for state/session objects",
        };
      }

      // Service method patterns
      if (expressionText.includes("Service") || expressionText.includes("service") ||
          expressionText.includes("Backend") || expressionText.includes("backend")) {
        return {
          level: "warn",
          messageId: "dangerousAsUnknown",
          context: `${expressionText} service`,
          suggestion: "Use proper service interfaces instead of casting to unknown",
        };
      }

      // Generic risky patterns (INFO level)
      return {
        level: "info",
        messageId: "riskAsUnknown",
        context: expressionText,
        suggestion: "Consider using proper types or type guards instead",
      };
    }

    return {
      TSAsExpression(node) {
        // Check if this is an 'as unknown' assertion
        if (node.typeAnnotation.type === "TSUnknownKeyword") {
          // Skip if we're in a test file and tests are allowed
          if (isTestFile && allowInTests) {
            return;
          }

          const analysis = analyzeAsUnknownPattern(node);
          if (!analysis) {
            return;
          }

          // Report based on severity level
          const reportConfig = {
            node,
            messageId: analysis.messageId,
            data: {
              context: analysis.context,
              suggestion: analysis.suggestion,
            },
          };

          // Add auto-fix for simple cases
          if (analysis.level === "error" && node.parent.type === "ReturnStatement") {
            if (node.expression.type === "Literal") {
              reportConfig.fix = function(fixer) {
                return fixer.replaceText(node, context.getSourceCode().getText(node.expression));
              };
            }
          }

          context.report(reportConfig);
        }
      },
    };
  },
};
