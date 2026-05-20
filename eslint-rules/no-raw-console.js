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
 * audit recorded in mt#1960 confirmed those directories contain ~127 raw
 * `console.*` calls (reviewer) and 2 calls (site) that bypass each service's
 * local logger. The decision (Option C narrowly): preserve the broad excludes
 * here so the migration ships as a pure mechanical change, and decompose the
 * adoption work into sibling subtasks:
 *
 *   - **mt#1982** — Finish mt#1255: adopt `log` across remaining
 *     `services/reviewer/**` source files. When this lands, drops the
 *     `services/reviewer/**` exemption block in `eslint.config.js`.
 *   - **mt#1983** — Add `services/site/src/logger.ts` + migrate the 2 calls
 *     in `services/site/src/server.ts`. When this lands, drops the
 *     `services/site/**` exemption block in `eslint.config.js`.
 *
 * Until those subtasks land, raw `console.*` in those directories is allowed.
 * Every other directory enforces this rule at `severity: error`.
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
        "Disallow raw console.* usage outside designated files; use the structured logger instead. See mt#1960; subtasks mt#1982 (reviewer) + mt#1983 (site) will lift per-service excludes.",
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

        const canAutofix = Boolean(logMethod) && logBindingInScope();

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
