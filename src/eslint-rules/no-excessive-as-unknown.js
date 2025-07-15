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
      category: "Best Practices",
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
          allowPatterns: {
            type: "array",
            items: {
              type: "string",
            },
            default: [],
          },
          maxAssertionsPerFile: {
            type: "integer",
            default: 5,
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      criticalPattern: "Critical: 'as unknown' assertion found in return statement - this masks real type errors",
      highRiskPattern: "High-risk: 'as unknown' assertion on {{pattern}} - consider proper typing instead",
      mediumRiskPattern: "Medium-risk: 'as unknown' assertion on {{pattern}} - evaluate if proper typing is possible",
      excessiveUsage: "Excessive 'as unknown' usage ({{count}}/{{max}}) - consider refactoring with proper types",
    },
  },

  create(context) {
    const options = context.options[0] || {};
    const { allowInTests = false, allowPatterns = [], maxAssertionsPerFile = 5 } = options;
    
    let assertionCount = 0;
    
    // Check if we're in a test file
    const filename = context.getFilename();
    const isTestFile = /\.(test|spec)\.(ts|js)$/.test(filename);
    
    // Pattern matchers for different risk levels
    const patterns = {
      critical: [
        /return\s+.*as\s+unknown/, // Return statements
        /=\s+null\s+as\s+unknown/, // Null assignments
        /=\s+undefined\s+as\s+unknown/, // Undefined assignments
      ],
      high: [
        /\(.*\..*\s+as\s+unknown\)\./, // Property access on casted objects
        /\(.*\s+as\s+unknown\)\[/, // Array/object access
        /\(.*\s+as\s+unknown\)\(/, // Function calls
        /\(this\s+as\s+unknown\)/, // This context assertions
      ],
      medium: [
        /process\.env\..*\s+as\s+unknown/, // Environment variables
        /JSON\.parse\(.*\)\s+as\s+unknown/, // JSON parsing
        /require\(.*\)\s+as\s+unknown/, // Module imports
      ],
    };

    function checkPattern(node, text) {
      // Skip if pattern is explicitly allowed
      if (allowPatterns.some(pattern => new RegExp(pattern).test(text))) {
        return;
      }

      // Skip if in test file and tests are allowed
      if (isTestFile && allowInTests) {
        return;
      }

      // Check critical patterns
      for (const pattern of patterns.critical) {
        if (pattern.test(text)) {
          context.report({
            node,
            messageId: "criticalPattern",
            fix(fixer) {
              // Simple fix for basic cases
              if (text.includes("null as unknown")) {
                return fixer.replaceText(node, text.replace(" as unknown", ""));
              }
              if (text.includes("undefined as unknown")) {
                return fixer.replaceText(node, text.replace(" as unknown", ""));
              }
              return null;
            },
          });
          return;
        }
      }

      // Check high-risk patterns
      for (const pattern of patterns.high) {
        if (pattern.test(text)) {
          const patternType = getPatternType(text);
          context.report({
            node,
            messageId: "highRiskPattern",
            data: { pattern: patternType },
          });
          return;
        }
      }

      // Check medium-risk patterns
      for (const pattern of patterns.medium) {
        if (pattern.test(text)) {
          const patternType = getPatternType(text);
          context.report({
            node,
            messageId: "mediumRiskPattern",
            data: { pattern: patternType },
          });
          return;
        }
      }
    }

    function getPatternType(text) {
      if (text.includes("process.env")) return "environment variable";
      if (text.includes("JSON.parse")) return "JSON parsing";
      if (text.includes("require(")) return "module import";
      if (text.includes("this as unknown")) return "this context";
      if (text.includes(")[")) return "array access";
      if (text.includes(")(")) return "function call";
      if (text.includes(").")) return "property access";
      return "unknown pattern";
    }

    return {
      TSAsExpression(node) {
        if (node.typeAnnotation.type === "TSUnknownKeyword") {
          assertionCount++;
          
          const sourceCode = context.getSourceCode();
          const text = sourceCode.getText(node.parent || node);
          
          checkPattern(node, text);
        }
      },
      
      "Program:exit"() {
        if (assertionCount > maxAssertionsPerFile) {
          context.report({
            node: context.getSourceCode().ast,
            messageId: "excessiveUsage",
            data: { 
              count: assertionCount, 
              max: maxAssertionsPerFile 
            },
          });
        }
      },
    };
  },
};
