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
 *      `console.error`, `this.logger.warn`, `req.log.error`,
 *      `getLogger().error`, `myLogger.warn`, `appLog.error`, etc.) — any
 *      `<receiver>.<level>(...)` where the level is one of
 *      error/warn/info/debug/log/fatal/trace and the receiver's name
 *      (the last property name in a member chain, a bare identifier, a
 *      computed string-literal key, or the callee name of a factory call
 *      like `getLogger()`) CONTAINS "log" or "console" as a substring,
 *      case-insensitively. Substring (not exact-name) matching is
 *      deliberate: a false NEGATIVE here (failing to recognize a real
 *      logging call under a locally-named variable like `myLogger`/`appLog`)
 *      causes a false POSITIVE at the rule level (a real log call wrongly
 *      flagged as "silent") — the failure mode reviewer feedback (PR #2392
 *      R1 BLOCKING #2) identified — so this favors recognizing too much
 *      over too little.
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

// Logger detection moved to `./logger-detection.js` (mt#4632) so
// `prefer-loggable-error-summary` shares this matcher rather than growing a
// second one that could drift. Behaviour here is unchanged — including the
// substring receiver match and its rationale, which travelled with the code.
// eslint-disable-next-line no-restricted-imports -- ESLint loads rule modules through Node's ESM loader, which requires the explicit .js extension; extensionless resolves under Bun but breaks `eslint` itself (verified mt#4632)
import { containsLoggerCall } from "./logger-detection.js";

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
