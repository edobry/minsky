/**
 * @fileoverview Tests for prefer-loggable-error-summary (mt#4632).
 *
 * The rule's whole value is the DISCRIMINATION — it must fire on a bare
 * `err.message` rendering that reaches a log call, and stay silent on the same
 * expression anywhere else. The invalid cases below cover the log side; the
 * valid cases cover every non-log destination the corpus actually contains,
 * because a false positive here pushes an author to discard detail at a `throw`
 * site, which is the opposite of what the rule is for.
 */

// eslint-disable-next-line no-restricted-imports -- ESLint rule tests must use .js extension for direct rule loading
import rule from "./prefer-loggable-error-summary.js";
import { RuleTester } from "eslint";
import * as tsParser from "@typescript-eslint/parser";
import path from "node:path";

const repoRoot = process.cwd();

function srcFile(...parts) {
  return path.join(repoRoot, "src", ...parts);
}

const tester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

const BARE = "err instanceof Error ? err.message : String(err)";

/** The rule's only messageId — named once so the invalid cases share it. */
const MESSAGE_ID = "preferLoggableErrorSummary";

tester.run("prefer-loggable-error-summary", rule, {
  valid: [
    // AT1's negative half: a throw re-wrapping with { cause } propagates the
    // chain intact. getLoggableErrorSummary's own docblock says NOT to truncate
    // here — flagging this would push authors to discard detail.
    {
      code: `try { q(); } catch (err) { throw new Error(\`failed: \${${BARE}}\`, { cause: err }); }`,
      filename: srcFile("cockpit", "a.ts"),
    },
    // A bare throw of the rendered string — still a throw, still not a log.
    {
      code: `try { q(); } catch (err) { throw new Error(${BARE}); }`,
      filename: srcFile("cockpit", "b.ts"),
    },
    // Not a log destination: returned to a caller, which may render it anywhere.
    {
      code: `function describe(err) { return ${BARE}; }`,
      filename: srcFile("cockpit", "c.ts"),
    },
    // Not a log destination: assigned into a plain value.
    {
      code: `try { q(); } catch (err) { const msg = ${BARE}; res.status(500).json({ msg }); }`,
      filename: srcFile("cockpit", "d.ts"),
    },
    // Already correct — the recommended helper is not itself flagged.
    {
      code: 'try { q(); } catch (err) { log.warn("failed", { error: getLoggableErrorSummary(err) }); }',
      filename: srcFile("cockpit", "e.ts"),
    },
    // A logger-shaped call whose receiver is NOT a logger.
    {
      code: `try { q(); } catch (err) { tracker.error(${BARE}); }`,
      filename: srcFile("cockpit", "f.ts"),
    },
    // Inside a callback: evaluated in the callback's own context, not as an
    // argument to the enclosing call. The function-boundary stop.
    {
      code: `log.warn("outer", items.map((err) => ${BARE}));`,
      filename: srcFile("cockpit", "g.ts"),
    },
    // PR #3380 R1 (BLOCKING): outside any error-handling context. The value is
    // merely instanceof-Error-tested in ordinary code — not a caught error — so
    // the rule must not fire even though it reaches a log call. Before the
    // scope check this was flagged; measured cost of adding it: 9 of 599 sites.
    {
      code: `const err = maybeError(); log.info("status", { detail: ${BARE} });`,
      filename: srcFile("cockpit", "n.ts"),
    },
    // The success half of `.then(onOk, onErr)` is not an error handler.
    {
      code: `p.then((err) => { log.info("ok", { detail: ${BARE} }); }, handleFailure);`,
      filename: srcFile("cockpit", "o.ts"),
    },
  ],

  invalid: [
    // AT1's positive half: the exact shape mt#4597 found in production —
    // nested inside an object argument, two levels below the call.
    {
      code: `try { q(); } catch (err) { log.warn("source failed", { error: ${BARE} }); }`,
      filename: srcFile("cockpit", "h.ts"),
      errors: [{ messageId: MESSAGE_ID }],
    },
    // Direct argument rather than nested.
    {
      code: `try { q(); } catch (err) { log.error(${BARE}); }`,
      filename: srcFile("cockpit", "i.ts"),
      errors: [{ messageId: MESSAGE_ID }],
    },
    // The getErrorMessage form — the other rendering the helper's docblock
    // names explicitly.
    {
      code: 'try { q(); } catch (err) { log.warn("failed", { error: getErrorMessage(err) }); }',
      filename: srcFile("cockpit", "j.ts"),
      errors: [{ messageId: MESSAGE_ID }],
    },
    // A locally-aliased logger — the substring receiver match inherited from
    // no-silent-catch is what makes this reachable.
    {
      code: `try { q(); } catch (err) { appLog.error("failed", { error: ${BARE} }); }`,
      filename: srcFile("cockpit", "k.ts"),
      errors: [{ messageId: MESSAGE_ID }],
    },
    // console counts as a logger receiver.
    {
      code: `try { q(); } catch (err) { console.error(${BARE}); }`,
      filename: srcFile("cockpit", "l.ts"),
      errors: [{ messageId: MESSAGE_ID }],
    },
    // Optional-chained logger call — the ChainExpression unwrap.
    {
      code: `try { q(); } catch (err) { logger?.warn("failed", { error: ${BARE} }); }`,
      filename: srcFile("cockpit", "m.ts"),
      errors: [{ messageId: MESSAGE_ID }],
    },
    // A promise rejection handler is the same class as a catch block. This is
    // why the scope check is `isInErrorHandlingContext` and not a bare
    // `CatchClause` test — scoping to the literal keyword would leave this
    // identical defect unflagged purely because of the syntax chosen.
    {
      code: `q().catch((err) => log.error("failed", { error: ${BARE} }));`,
      filename: srcFile("cockpit", "p.ts"),
      errors: [{ messageId: MESSAGE_ID }],
    },
    // The rejection half of `.then(onOk, onErr)`.
    {
      code: `q().then(ok, (err) => log.error("failed", { error: ${BARE} }));`,
      filename: srcFile("cockpit", "q.ts"),
      errors: [{ messageId: MESSAGE_ID }],
    },
    // PR #3380 R1 (NON-BLOCKING), pinned rather than left to surprise someone:
    // the receiver match is a SUBSTRING test inherited from no-silent-catch, so
    // `catalog` matches on "log" and this IS flagged. For no-silent-catch that
    // over-recognition is the safe direction; for this rule it is a false
    // positive. Kept anyway, because forking the matcher would reintroduce the
    // drift the shared module exists to prevent — and measured: ZERO
    // `catalog|dialog|backlog|blog|changelog|analog`-style logger-method
    // receivers exist in src/packages/services/scripts today. If one ever
    // appears, this test is where the decision gets revisited.
    {
      code: `try { q(); } catch (err) { catalog.error("failed", { error: ${BARE} }); }`,
      filename: srcFile("cockpit", "r.ts"),
      errors: [{ messageId: MESSAGE_ID }],
    },
  ],
});
