/**
 * @fileoverview ESLint rule flagging `execSync(`/`spawnSync(`/`fetch(` call
 * sites that lack a timeout / AbortSignal argument (mt#3299, gate 2 of the
 * mt#3295 corpus-derived gate wave — the mechanizable slice of the
 * unguarded-edge-case class, 322 findings / 38%).
 *
 * Sibling of `no-unsafe-git-exec.js` (which covers `git`-specific
 * exec/execAsync calls and enforces the timeout-aware wrapper functions).
 * This rule is broader-but-shallower: it doesn't know about any specific
 * wrapper API, it just checks whether a `timeout`/`signal` option is present
 * inline. Example finding: "Unbounded execSync call in defaultRunGit can
 * hang the PreToolUse hook" (block-git-gh-cli.ts:126). Hooks
 * (.minsky/hooks/, .claude/hooks/) are the top concentration area for this
 * class (54 + 20 findings) and already have a per-hook timeout-budget
 * convention to lint against.
 *
 * Detection (permissive — false negatives preferred over false positives):
 *   - `execSync(cmd)` / `execSync(cmd, opts)` — flagged unless `opts` is an
 *     object literal containing a `timeout` property. An `opts` argument
 *     that is a non-literal EXPRESSION whose runtime shape can't be seen
 *     (an identifier, member expression, call, spread, etc.) is treated as
 *     "unknown" and SKIPPED — it might resolve to an object carrying
 *     `timeout` at runtime. An `opts` argument whose shape IS staticaly
 *     visible but definitely ISN'T (or can't carry) an options object with
 *     `timeout` — an array/string/template/number/boolean/function literal
 *     — is NOT given the same benefit of the doubt: it is classified
 *     "absent" and flagged, same as no second argument at all (PR #2392 R1
 *     BLOCKING #1 — `spawnSync(cmd, ["args"])` with no options was being
 *     silently skipped because an array literal was lumped in with "can't
 *     tell").
 *   - `spawnSync(cmd, args, opts)` / `spawnSync(cmd, opts)` — same rule
 *     applied to whichever argument is an object literal in the timeout
 *     position (2nd or 3rd argument); an args-array literal in the 2nd
 *     position no longer masks a missing 3rd-position `opts`.
 *   - `fetch(url)` / `fetch(url, init)` — flagged unless `init` is an object
 *     literal containing a `signal` property, same absent/present/unknown
 *     classification as above. `signal` (not a timeout number) is the
 *     correct guard for `fetch` because the web/undici `fetch` API has no
 *     native timeout option — cancellation is exclusively via
 *     `AbortController`/`AbortSignal.timeout(ms)` passed as `signal`, so
 *     that is the only inline shape this rule can recognize as "bounded."
 *     A `fetch` wrapped in `Promise.race([...])` with a manual timeout, or
 *     one relying on a caller-supplied default via an already-configured
 *     `Request`, isn't visible to a single-call-site check like this one —
 *     accepted as a scope limit, not a bug (mt#3299 review non-blocking #2).
 *
 * Already-safe wrapper calls (`execGitWithTimeout`, `execAsync` from
 * `@minsky/shared/exec`, `gitPushWithTimeout` etc.) are skipped entirely —
 * they are the codebase's OWN timeout-enforcing primitives. Calling a LOCAL
 * variable that happens to alias one of these (e.g. `const run = execAsync;
 * run(cmd)`) or a promisified `child_process.exec` under a custom name is
 * NOT recognized — this rule matches by literal callee name only, the same
 * convention `no-unsafe-git-exec` already uses; alias-tracking would need
 * scope/type analysis this rule deliberately doesn't do.
 *
 * Tracking task: mt#3299.
 */

const SAFE_WRAPPER_NAMES = new Set([
  "execGitWithTimeout",
  "execAsync",
  "gitPushWithTimeout",
  "gitPullWithTimeout",
  "gitFetchWithTimeout",
  "gitCloneWithTimeout",
]);

function calleeName(node) {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  return null;
}

// Node types whose SHAPE is statically visible and definitely CANNOT carry an
// arbitrary `timeout`/`signal` property the way a plain object literal can —
// an array (e.g. an `args` list mistaken for options), a string/number/
// boolean/regex/null literal, a template literal, or a function expression.
// Encountering one of these in an options position is treated the SAME as no
// argument at all ("absent"), not given the "unknown, skip" benefit of the
// doubt reserved for expressions whose runtime shape isn't visible (mt#3299
// PR #2392 R1 BLOCKING #1).
const DEFINITELY_NOT_AN_OPTIONS_OBJECT = new Set([
  "ArrayExpression",
  "Literal",
  "TemplateLiteral",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/**
 * Classify whether `key` (e.g. "timeout"/"signal") is present on `arg`:
 *   - "absent"  — `arg` is undefined (no options argument at all), OR `arg`
 *     is an object literal that does NOT contain `key`, OR `arg`'s shape is
 *     statically visible and definitely isn't an options-carrying object
 *     (see `DEFINITELY_NOT_AN_OPTIONS_OBJECT`). All three are clear
 *     violations — there is definitely no timeout/signal wired.
 *   - "present" — `arg` is an object literal that DOES contain `key`.
 *   - "unknown" — `arg` exists but its shape can't be seen (identifier,
 *     member expression, call expression, spread, etc.) — it MIGHT resolve
 *     to an object carrying `key` at runtime, so the caller should SKIP
 *     (permissive: false negatives preferred over false positives).
 */
function classifyOptionProperty(arg, key) {
  if (arg === undefined) return "absent";
  if (arg.type === "ObjectExpression") {
    const has = arg.properties.some((p) => {
      if (p.type !== "Property") return false;
      if (p.key.type === "Identifier") return p.key.name === key;
      if (p.key.type === "Literal") return p.key.value === key;
      return false;
    });
    return has ? "present" : "absent";
  }
  if (DEFINITELY_NOT_AN_OPTIONS_OBJECT.has(arg.type)) return "absent";
  return "unknown";
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Flag execSync/spawnSync/fetch call sites lacking a timeout/AbortSignal argument (mt#3299).",
      category: "Best Practices",
      recommended: true,
    },
    fixable: null,
    schema: [],
    messages: {
      missingTimeout:
        "{{callee}}(...) has no visible timeout/AbortSignal argument — an unbounded call here " +
        "can hang the calling process indefinitely. Pass a `timeout`/`signal` option, or use a " +
        "timeout-aware wrapper. See mt#3299.",
    },
  },

  create(context) {
    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (!name || SAFE_WRAPPER_NAMES.has(name)) return;

        if (name === "execSync") {
          const state = classifyOptionProperty(node.arguments[1], "timeout");
          if (state !== "absent") return; // "present" is safe; "unknown" is a permissive skip
          context.report({ node, messageId: "missingTimeout", data: { callee: name } });
          return;
        }

        if (name === "spawnSync") {
          // spawnSync(cmd, opts) or spawnSync(cmd, args, opts) — the options
          // object can be in either position. If EITHER position is a literal
          // WITH `timeout`, it's safe. If both positions are non-literals
          // (identifiers), skip (permissive — can't verify). Otherwise absent.
          const arg1State = classifyOptionProperty(node.arguments[1], "timeout");
          const arg2State = classifyOptionProperty(node.arguments[2], "timeout");
          if (arg1State === "present" || arg2State === "present") return;
          if (arg1State === "unknown" || arg2State === "unknown") return;
          context.report({ node, messageId: "missingTimeout", data: { callee: name } });
          return;
        }

        if (name === "fetch") {
          const state = classifyOptionProperty(node.arguments[1], "signal");
          if (state !== "absent") return;
          context.report({ node, messageId: "missingTimeout", data: { callee: name } });
        }
      },
    };
  },
};
