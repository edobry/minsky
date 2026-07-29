/**
 * @fileoverview ESLint rule requiring every `catch` block to either rethrow,
 * log via the structured logger/console, or carry an explicit
 * `// intentional-swallow: <reason>` comment (mt#3299, gate 1 of the mt#3295
 * corpus-derived gate wave — silent-failure class, 47 findings / 5.6%).
 *
 * A catch block that does none of the three is a silent failure: the error
 * is discarded with no trace, no rethrow, and no documented reason it's safe
 * to discard. Example finding this class covers: "Latch still sets on
 * DB-insert failure because EventEmitter.emit() never signals failure"
 * (embeddings-health-tracker.ts:180).
 *
 * The three escape hatches, any ONE of which satisfies the rule:
 *   1. A `throw` statement anywhere in the catch block (rethrow, possibly
 *      wrapped/annotated).
 *   2. A call to a logger/console method (`log.error`, `logger.warn`,
 *      `console.error`, etc. — any `<ident>.<level>(...)` where the level is
 *      one of error/warn/info/debug/log/fatal/trace and the receiver
 *      identifier is/ends with log/logger/console).
 *   3. A comment anywhere INSIDE the catch block's source range containing
 *      `intentional-swallow:`.
 *
 * Test files are excluded by default (`allowInTests`, default true) — a
 * catch block asserting "this does not throw" is a common, benign test
 * pattern distinct from the production silent-failure class this rule
 * targets.
 *
 * Tracking task: mt#3299.
 */

const LOG_METHOD_RE = /^(error|warn|info|debug|log|fatal|trace)$/;
const LOG_RECEIVER_RE = /(^|[._])(log|logger|console)$/i;
const INTENTIONAL_SWALLOW_RE = /intentional-swallow:/;

/** Recursively check whether any node in the subtree is a ThrowStatement. */
function containsThrow(node) {
  if (!node || typeof node !== "object") return false;
  if (node.type === "ThrowStatement") return true;
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === "string" && containsThrow(child)) return true;
      }
    } else if (value && typeof value.type === "string") {
      if (containsThrow(value)) return true;
    }
  }
  return false;
}

/** Recursively check whether any node in the subtree is a qualifying logger call. */
function containsLoggerCall(node) {
  if (!node || typeof node !== "object") return false;
  if (node.type === "CallExpression" && node.callee && node.callee.type === "MemberExpression") {
    const callee = node.callee;
    const methodName = callee.property && !callee.computed ? callee.property.name : null;
    if (methodName && LOG_METHOD_RE.test(methodName)) {
      const receiver = callee.object;
      let receiverName = null;
      if (receiver.type === "Identifier") {
        receiverName = receiver.name;
      } else if (receiver.type === "MemberExpression" && !receiver.computed) {
        receiverName = receiver.property.name;
      } else if (receiver.type === "ThisExpression") {
        receiverName = null;
      }
      if (receiverName && LOG_RECEIVER_RE.test(receiverName)) return true;
    }
  }
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === "string" && containsLoggerCall(child)) return true;
      }
    } else if (value && typeof value.type === "string") {
      if (containsLoggerCall(value)) return true;
    }
  }
  return false;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require every catch block to rethrow, log, or carry an " +
        "`// intentional-swallow: <reason>` comment (mt#3299).",
      category: "Best Practices",
      recommended: true,
    },
    fixable: null,
    schema: [
      {
        type: "object",
        properties: {
          allowInTests: {
            type: "boolean",
            default: true,
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      silentCatch:
        "catch block silently swallows the error — add a rethrow, a log.*/console.* call, " +
        "or an `// intentional-swallow: <reason>` comment explaining why discarding it is safe. " +
        "See mt#3299.",
    },
  },

  create(context) {
    const options = context.options[0] || {};
    const allowInTests = options.allowInTests !== false;
    const filename = context.getFilename();
    const isTestFile = /\.(test|spec)\.[jt]sx?$/.test(filename);
    if (allowInTests && isTestFile) return {};

    const sourceCode = context.getSourceCode();

    return {
      CatchClause(node) {
        if (containsThrow(node.body)) return;
        if (containsLoggerCall(node.body)) return;

        const commentsInside = sourceCode.getCommentsInside(node);
        const hasSwallowComment = commentsInside.some((c) => INTENTIONAL_SWALLOW_RE.test(c.value));
        if (hasSwallowComment) return;

        context.report({ node, messageId: "silentCatch" });
      },
    };
  },
};
