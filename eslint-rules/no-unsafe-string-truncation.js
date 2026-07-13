/**
 * @fileoverview ESLint rule to prevent unsafe character-bounded string truncation
 *
 * Detects calls to `.slice()`, `.substring()`, and `.substr()` whose first argument
 * is a numeric literal (0) — the "head" truncation pattern — when the receiver is
 * plausibly a string. These produce unpaired UTF-16 surrogates (broken emoji) when
 * the cut falls between a high and low surrogate.
 *
 * Use `safeTruncate` from `src/utils/safe-truncate.ts` instead.
 *
 * Reference: mt#1615 — surrogate-safe truncation sweep
 *
 * Exemptions (add eslint-disable-next-line with justification):
 *   - SHA prefixes: .slice(0, 8) on a known SHA string
 *   - Fixed-format identifiers where content is guaranteed ASCII
 *   - Array slices (the rule only fires on string-typed receivers)
 */

// ── Constants ────────────────────────────────────────────────────────────────

/** Methods that produce head-truncation when first arg is 0 */
const HEAD_TRUNCATE_METHODS = new Set(["slice", "substring", "substr"]);

/**
 * Type-system-independent check for "this looks like a string method chain."
 * We can't run the type checker from an AST-only rule, so we use conservative heuristics:
 *   1. The receiver was produced by a string-only method (.trim, .toLowerCase, .replace, …)
 *   2. The receiver is a string template literal or `+` concat
 *   3. The identifier name is exactly one of a small set of singular string-typed names
 *
 * Deliberately conservative to minimize false positives on array variables.
 * We do NOT match plural names (messages, items, results, …) or ambiguous names.
 */
function isPlausiblyString(node) {
  if (!node) return false;

  // Template literal → always string
  if (node.type === "TemplateLiteral") return true;

  // String binary concatenation `a + b` — both sides should be strings
  if (node.type === "BinaryExpression" && node.operator === "+") return true;

  // MemberExpression whose property is a string-ONLY method (cannot be called on arrays)
  // .trim(), .toLowerCase(), .toUpperCase(), .replace() only work on strings.
  // Excludes toString/toISOString/toTimeString — those produce fixed-format ASCII output.
  if (node.type === "CallExpression" && node.callee.type === "MemberExpression") {
    const propName = node.callee.property.name;
    if (["trim", "toLowerCase", "toUpperCase", "replace"].includes(propName)) {
      return true;
    }
  }

  // Identifier: only flag a conservative set of clearly singular string variable names.
  // Singular vs plural matters here — "message" is a string, "messages" is an array.
  if (node.type === "Identifier") {
    const name = node.name;
    // Exact matches — most common singular string variable names in this codebase
    const EXACT_STRING_NAMES = new Set([
      "str",
      "string",
      "content",
      "text",
      "body",
      "message",
      "title",
      "description",
      "summary",
      "quote",
      "label",
      "comment",
      "reason",
      "rationale",
      "spec",
      "output",
      "input",
      "excerpt",
    ]);
    if (EXACT_STRING_NAMES.has(name)) return true;

    // Suffix matches for common patterns like "userText", "rawMessage", "reviewBody"
    const lname = name.toLowerCase();
    return (
      lname.endsWith("text") ||
      lname.endsWith("content") ||
      lname.endsWith("body") ||
      lname.endsWith("str") ||
      lname.endsWith("string") ||
      lname.endsWith("message") ||
      lname.endsWith("description") ||
      lname.endsWith("summary")
    );
  }

  return false;
}

/**
 * Returns true if the first argument of a call is exactly the numeric literal 0.
 * This is the head-truncation pattern: `.slice(0, N)`, `.substring(0, N)`.
 */
function firstArgIsZero(args) {
  return (
    args.length >= 1 &&
    args[0].type === "Literal" &&
    typeof args[0].value === "number" &&
    args[0].value === 0
  );
}

/**
 * Returns true if a tail-slice pattern is used: `.slice(-N)` (negative first arg).
 * These are also unsafe on strings.
 */
function firstArgIsNegativeLiteral(args) {
  return (
    args.length >= 1 &&
    args[0].type === "UnaryExpression" &&
    args[0].operator === "-" &&
    args[0].argument.type === "Literal" &&
    typeof args[0].argument.value === "number"
  );
}

// ── Rule definition ──────────────────────────────────────────────────────────

export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow unsafe character-bounded string truncation that may split surrogate pairs",
      category: "Best Practices",
      recommended: false,
      url: "https://github.com/edobry/minsky/blob/main/src/utils/safe-truncate.ts",
    },
    schema: [
      {
        type: "object",
        properties: {
          allowlist: {
            type: "array",
            items: { type: "string" },
            description: "Variable names explicitly allowed to use raw slice/substring",
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      unsafeHeadTruncation:
        "Unsafe string truncation: `.{{method}}(0, N)` may split a UTF-16 surrogate pair. " +
        "Use `safeTruncate(str, N, 'head')` from `src/utils/safe-truncate.ts` instead. " +
        "Add eslint-disable-next-line with justification if the string is known-ASCII.",
      unsafeTailTruncation:
        "Unsafe string truncation: `.{{method}}(-N)` may split a UTF-16 surrogate pair. " +
        "Use `safeTruncate(str, N, 'tail')` from `src/utils/safe-truncate.ts` instead. " +
        "Add eslint-disable-next-line with justification if the string is known-ASCII.",
    },
  },

  create(context) {
    const options = context.options[0] ?? {};
    const allowlist = new Set(options.allowlist ?? []);

    return {
      CallExpression(node) {
        const { callee, arguments: args } = node;

        // Must be a MemberExpression: `receiver.method(...)`
        if (callee.type !== "MemberExpression") return;
        if (callee.computed) return; // skip bracket-notation

        const methodName = callee.property.name;
        if (!HEAD_TRUNCATE_METHODS.has(methodName)) return;

        const receiver = callee.object;

        // Skip if receiver is explicitly in the allowlist
        if (receiver.type === "Identifier" && allowlist.has(receiver.name)) return;

        // Only flag when the receiver is plausibly a string
        if (!isPlausiblyString(receiver)) return;

        // Head truncation: .slice(0, N) / .substring(0, N) / .substr(0, N)
        if (firstArgIsZero(args)) {
          context.report({
            node,
            messageId: "unsafeHeadTruncation",
            data: { method: methodName },
          });
          return;
        }

        // Tail truncation: .slice(-N) — only for slice, not substring/substr
        if (methodName === "slice" && firstArgIsNegativeLiteral(args)) {
          context.report({
            node,
            messageId: "unsafeTailTruncation",
            data: { method: methodName },
          });
        }
      },
    };
  },
};
