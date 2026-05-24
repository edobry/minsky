/**
 * ESLint rule to prevent raw `console.{log,info,warn,error,debug,...}` usage.
 *
 * Replaces the legacy regex-based standalone script `scripts/lint-console-usage.ts`
 * (retired by mt#1960). AST-walks `MemberExpression[object.name === "console"]`
 * inside `CallExpression`s and reports each call site. Per-file scoping is done
 * via ESLint's standard `files` / `ignores` plumbing in `eslint.config.js` — this
 * rule does NOT carry a parallel exclude list.
 *
 * # Disposition for `services/reviewer/**` and `services/site/**` (mt#1960)
 *
 * The legacy script broadly excluded both service directories. The 2026-05-20
 * audit recorded in mt#1960 confirmed those directories contained ~127 raw
 * `console.*` calls (reviewer) and 2 calls (site). The exclude blocks have
 * since been removed as the migration work completed:
 *
 *   - **mt#1982** — Finished mt#1255: `log` adopted across all
 *     `services/reviewer/**` source files. Exclude block removed.
 *   - **mt#1983** — Added `services/site/src/logger.ts` and migrated the 2
 *     calls in `services/site/src/server.ts`. Exclude block removed.
 *
 * The rule now fires at `severity: error` across every directory.
 *
 * # Allowed patterns
 *
 * Specific known-good call shapes (e.g., test-monitoring messages) can be
 * exempted via the rule's `allowedPatterns` option — an array of strings
 * matched as substrings against the source text of each console call. This
 * mirrors the legacy script's pattern allowlist.
 *
 * # Auto-fix
 *
 * When a `log` symbol is in scope (i.e., the file imports `log` from a logger
 * module), `console.{log,info,warn,error,debug}` is rewritten to
 * `log.{info,info,warn,error,debug}` respectively. For other console methods
 * (trace, dir, table, time, etc.) no fix is offered — the call shape doesn't
 * map cleanly to the standard logger surface.
 */

const CONSOLE_METHODS = new Set([
  "log",
  "info",
  "warn",
  "error",
  "debug",
  "trace",
  "dir",
  "table",
  "time",
  "timeEnd",
  "assert",
  "count",
  "group",
  "groupEnd",
]);

// console.<key> → log.<value>. Methods not in the map get no autofix.
const LOG_METHOD_MAP = {
  log: "info",
  info: "info",
  warn: "warn",
  error: "error",
  debug: "debug",
};

/**
 * Walk the program body for a top-level ImportDeclaration that brings a
 * binding named `log` into scope (named, default, or namespace import).
 * Returns true if `log` is bound at module scope.
 */
function hasLogBinding(program) {
  if (!program || program.type !== "Program") return false;
  for (const node of program.body) {
    if (node.type !== "ImportDeclaration") continue;
    for (const spec of node.specifiers) {
      if (spec.type === "ImportSpecifier" && spec.local.name === "log") return true;
      if (spec.type === "ImportDefaultSpecifier" && spec.local.name === "log") return true;
      if (spec.type === "ImportNamespaceSpecifier" && spec.local.name === "log") return true;
    }
  }
  return false;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw console.* usage outside designated files; use the structured logger instead. See mt#1960 for the migration rule rationale; the reviewer + site per-service excludes were retired by mt#1982 + mt#1983 respectively.",
    },
    fixable: "code",
    schema: [
      {
        type: "object",
        properties: {
          allowedPatterns: {
            type: "array",
            items: { type: "string" },
            default: [],
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      rawConsole:
        "Raw `console.{{method}}` call — route through the structured logger (e.g., `log.{{suggestion}}`) instead. See mt#1960 for the migration rule rationale.",
    },
  },

  create(context) {
    const options = context.options[0] || {};
    const allowedPatterns = Array.isArray(options.allowedPatterns) ? options.allowedPatterns : [];

    const sourceCode = context.getSourceCode();
    let cachedHasLog = null;

    function logBindingInScope() {
      if (cachedHasLog === null) {
        // sourceCode.ast is the Program node.
        cachedHasLog = hasLogBinding(sourceCode.ast);
      }
      return cachedHasLog;
    }

    function callMatchesAllowedPattern(callText) {
      for (const pattern of allowedPatterns) {
        if (callText.includes(pattern)) return true;
      }
      return false;
    }

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          !callee ||
          callee.type !== "MemberExpression" ||
          callee.computed ||
          !callee.object ||
          callee.object.type !== "Identifier" ||
          callee.object.name !== "console" ||
          !callee.property ||
          callee.property.type !== "Identifier"
        ) {
          return;
        }

        const method = callee.property.name;
        if (!CONSOLE_METHODS.has(method)) return;

        const callText = sourceCode.getText(node);
        if (callMatchesAllowedPattern(callText)) return;

        const logMethod = LOG_METHOD_MAP[method];
        const suggestion = logMethod || "info";

        // Optional-chaining nodes (e.g., `console?.log("x")`, `console.log?.("x")`)
        // are reported but NOT autofixed. The naive `replaceText(callee, "log.info")`
        // would drop the `?.` operator, changing short-circuiting semantics or
        // emitting invalid syntax. ESTree sets `optional: true` on the
        // MemberExpression (for `console?.log`) and on the CallExpression
        // (for `console.log?.()`).
        const hasOptionalChaining = callee.optional === true || node.optional === true;
        const canAutofix = Boolean(logMethod) && logBindingInScope() && !hasOptionalChaining;

        context.report({
          node,
          messageId: "rawConsole",
          data: {
            method,
            suggestion,
          },
          fix: canAutofix ? (fixer) => fixer.replaceText(callee, `log.${logMethod}`) : undefined,
        });
      },
    };
  },
};
