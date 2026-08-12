/**
 * @fileoverview Require a `guardOutcome` decision in any hook that writes to the
 * fire log (mt#3920, criterion 4).
 *
 * mt#3892 gave guard-health a clean-run signal: `GuardHealthEntry.liveness` reads
 * `recovered` when a guard has decided cleanly since its last failure, joined from
 * fire-log records carrying `guardOutcome: "decided"`. Absence of the marker is
 * deliberately read as NO evidence, so a guard that never sets it can never leave
 * `dormant` once it records a failure.
 *
 * The marker was then added in exactly TWO places — `dispatcher.ts` and
 * `parallel-work-guard-standalone.ts` — and not in the other ten standalone writers.
 * Nothing caught that for two months. This rule is the mechanical check that stops the
 * eleventh from shipping the same way.
 *
 * WHAT IT CHECKS, AND WHY IT IS FILE-LEVEL.
 *
 * Not "every `recordFireLogEntry` call passes `guardOutcome`" — that would be WRONG.
 * The field is legitimately UNSET at a large share of exits: an override, an unrelated
 * tool, a short-circuit taken before the check ran. Those exits are evidence of neither
 * a clean decision nor a crash, and mt#3892's whole design rests on keeping them out of
 * the recovery join.
 *
 * The checkable invariant is the one the gap actually violated: a hook that writes
 * fire-log records must have CONSIDERED the marker somewhere in the file. A file with a
 * writer and no mention of `guardOutcome` — and no `"decided"` / `"crashed"` argument —
 * has not; every record it writes is inadmissible as clean-run evidence, forever, and
 * silently. That is decidable statically, needs no runtime probe, and fires at authoring
 * time.
 *
 * TRIGGERS include the merge-gate factory, not just the raw writer. A merge gate reaches
 * the fire log through `makeRecordAndExit` and never names `recordFireLogEntry` at all,
 * so a rule keyed on the raw writer alone would miss all eleven of them — the exact
 * shape of the original gap, one level up.
 *
 * Coverage model (mirrors `require-hook-domain-bootstrap`, mt#3046/mt#3178): coverage is
 * declared in TWO places that MUST stay in sync — the `files` glob of the
 * `require-guard-outcome-in-fire-log` block in `eslint.config.js`, and
 * `COVERED_ROOTS_POSIX` below. A root present in only one is silently unenforced; that
 * is not hypothetical, it is what mt#3178 hit on the sibling rule. Config remains the
 * primary scoping mechanism; the path check is the direct/RuleTester companion.
 *
 * Scoped to `.minsky/hooks/**` — the SOURCE tree. `.claude/hooks/**` is generated from
 * it (see `hook-files.mdc`), so linting both would double-report one authoring mistake.
 *
 * Exemptions: `.test.ts` / `.spec.ts` siblings (a test legitimately names the writer
 * while asserting on records it builds by hand), and `fire-log.ts` itself, which DEFINES
 * the field.
 *
 * Precedents: `custom/require-hook-domain-bootstrap` (mt#3046),
 * `custom/no-unregistered-minsky-env-var` (mt#1788).
 */

import { sep as pathSep } from "node:path";

/**
 * Trees subject to the invariant.
 *
 * Must stay in sync with the `files` glob of the `require-guard-outcome-in-fire-log`
 * block in `eslint.config.js` — see the coverage-model note in the file header for what
 * breaks when they diverge.
 */
const COVERED_ROOTS_POSIX = [".minsky/hooks"];

/**
 * Calls that put a record into the fire log.
 *
 * `recordFireLogEntry` is the writer itself. The other three are `merge-gate-fire-log.ts`'s
 * factory surface: a merge gate calls `makeRecordAndExit` (or the mt#3630 split halves)
 * and reaches the writer through it, without ever naming the writer.
 */
const FIRE_LOG_WRITER_CALLEES = new Set([
  "recordFireLogEntry",
  "makeRecordAndExit",
  "makeMergeGateDecider",
  "dispatchMergeGateDecision",
]);

/** The field itself — the direct way to satisfy the invariant. */
const OUTCOME_FIELD = "guardOutcome";

/**
 * The two outcome values.
 *
 * A merge gate passes these POSITIONALLY (`recordAndExit("deny", undefined, "decided")`),
 * so the field name never appears in the file. Accepting the literals is what makes the
 * factory-mediated callers checkable at all.
 */
const OUTCOME_VALUES = new Set(["decided", "crashed"]);

/** The module that defines the field, and so cannot be required to consume it. */
const FIRE_LOG_MODULE_BASENAME = "fire-log";

function toPosix(filename) {
  return filename.split(pathSep).join("/");
}

/** Is this file a hook source file subject to the invariant? */
function isCoveredHookFile(filename) {
  const normalized = toPosix(filename);
  if (!COVERED_ROOTS_POSIX.some((root) => normalized.includes(`${root}/`))) return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized)) return false;
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (base.replace(/\.[cm]?[jt]sx?$/, "") === FIRE_LOG_MODULE_BASENAME) return false;
  return true;
}

/** The callee name of a CallExpression, for both `f()` and `obj.f()`. */
function calleeName(node) {
  const callee = node.callee;
  if (callee?.type === "Identifier") return callee.name;
  if (callee?.type === "MemberExpression" && callee.property?.type === "Identifier") {
    return callee.property.name;
  }
  return null;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a hook that writes fire-log records to set guardOutcome somewhere, so guard-health's recovery join can see its clean runs (mt#3920)",
    },
    schema: [],
    messages: {
      missingGuardOutcome:
        'This hook writes fire-log records ({{trigger}}) but never sets `guardOutcome`. Absence is read as NO clean-run evidence (mt#3892), so guard-health can never report this guard `recovered` — it pins at `dormant` the moment it records its first failure. Mark each exit point: `"decided"` where the guard exercised its check and reached a verdict, `"crashed"` where the record stands in for a FAILED evaluation (a fail-open on a broken probe), and leave it UNSET where the guard did not run (an override, or a short-circuit before the path that can fail). See mt#3920 and `.minsky/hooks/merge-gate-fire-log.ts`\'s `MergeGateOutcome`.',
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (!isCoveredHookFile(filename)) return {};

    let satisfied = false;
    /** First node that proves this file writes to the fire log, plus what proved it. */
    let trigger = null;

    function noteTrigger(node, description) {
      if (!trigger) trigger = { node, description };
    }

    return {
      CallExpression(node) {
        const name = calleeName(node);
        if (name && FIRE_LOG_WRITER_CALLEES.has(name)) {
          noteTrigger(node, `call to '${name}'`);
        }
      },

      // `guardOutcome` named anywhere: a property in a record literal, a variable, a
      // parameter, a type annotation, a destructure. Any of them means the author made a
      // decision about the marker rather than not knowing it exists.
      Identifier(node) {
        if (node.name === OUTCOME_FIELD) satisfied = true;
      },

      // The positional form used by the merge-gate factory's call sites, where the field
      // name never appears.
      Literal(node) {
        if (typeof node.value === "string" && OUTCOME_VALUES.has(node.value)) satisfied = true;
      },

      "Program:exit"(programNode) {
        if (!trigger || satisfied) return;
        // One report per file: the invariant is a file-level property, and flagging every
        // writer call would bury it.
        context.report({
          node: trigger.node ?? programNode,
          messageId: "missingGuardOutcome",
          data: { trigger: trigger.description },
        });
      },
    };
  },
};
