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
 * shape of the original gap, one level up. Triggers also follow ALIASED and NAMESPACE
 * imports (PR #2901 R1): keying on the callee's spelling alone let a hook write fire-log
 * records under any local name and escape the rule entirely.
 *
 * SATISFACTION is the field name anywhere, or a `"decided"` / `"crashed"` literal in a
 * call-argument or object-property position. The literal branch is what makes the
 * factory-mediated callers checkable at all — they pass the outcome POSITIONALLY, so the
 * field name appears nowhere in their files. It is position-SCOPED (PR #2901 R1) because
 * accepting the literal anywhere let a stray `const note = "decided";` satisfy the rule
 * with every exit unmarked. Requiring the callee to resolve to a writer would be tighter
 * still and would reject every real merge-gate caller, since each calls a LOCAL closure
 * built from the factory rather than the factory itself.
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
export const COVERED_ROOTS_POSIX = [".minsky/hooks"];

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

/**
 * Module specifiers the writer surface is imported from, matched as suffixes so both
 * `./fire-log` and `../hooks/merge-gate-fire-log` land the same way. Used only for the
 * alias mapping below — a call whose callee already carries a known name is a trigger
 * regardless of how it got into scope.
 */
const WRITER_MODULE_SUFFIXES = ["fire-log", "merge-gate-fire-log"];

/** String value of an import source, or null. */
function sourceValue(node) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map((q) => q.value.cooked ?? "").join("");
  }
  return null;
}

function isWriterModuleSpecifier(value) {
  if (value == null) return false;
  const withoutExt = value.replace(/\.[cm]?[jt]sx?$/, "");
  return WRITER_MODULE_SUFFIXES.some((suffix) => withoutExt.endsWith(suffix));
}

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
    /**
     * R1: local names bound to the writer surface by an import, so an ALIASED import
     * (`import { recordFireLogEntry as writeFire }`) is still a trigger. Without this a
     * hook could write to the fire log under any local name and escape the rule entirely
     * — a silent hole in exactly the enforcement this rule exists to provide.
     */
    const writerLocals = new Set();
    /** Namespace imports of the writer modules, for `fireLog.recordFireLogEntry(...)`. */
    const writerNamespaces = new Set();

    function noteTrigger(node, description) {
      if (!trigger) trigger = { node, description };
    }

    return {
      ImportDeclaration(node) {
        if (!isWriterModuleSpecifier(sourceValue(node.source))) return;
        for (const spec of node.specifiers) {
          if (spec.type === "ImportSpecifier") {
            const imported = spec.imported?.name ?? spec.imported?.value;
            if (imported && FIRE_LOG_WRITER_CALLEES.has(imported)) {
              writerLocals.add(spec.local.name);
            }
          } else if (spec.type === "ImportNamespaceSpecifier") {
            writerNamespaces.add(spec.local.name);
          }
        }
      },

      CallExpression(node) {
        const name = calleeName(node);
        // A call whose callee carries a known writer name is a trigger however it got into
        // scope; an aliased local is a trigger because the import bound it to one.
        if (name && (FIRE_LOG_WRITER_CALLEES.has(name) || writerLocals.has(name))) {
          noteTrigger(node, `call to '${name}'`);
          return;
        }
        // `import * as fireLog` → `fireLog.recordFireLogEntry(...)`.
        const callee = node.callee;
        if (
          callee?.type === "MemberExpression" &&
          callee.object?.type === "Identifier" &&
          writerNamespaces.has(callee.object.name) &&
          name &&
          FIRE_LOG_WRITER_CALLEES.has(name)
        ) {
          noteTrigger(node, `call to '${callee.object.name}.${name}'`);
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
      //
      // R1: SCOPED to a call-argument or object-property position. Accepting the literal
      // anywhere meant a stray `const note = "decided";` satisfied the rule while every
      // exit stayed unmarked — a false negative in the one direction that matters. The two
      // positions kept are the two the real forms use: `recordAndExit("deny", undefined,
      // "decided")` and `{ guardOutcome: "decided" }`. Requiring the callee itself to
      // resolve to a writer would be tighter still and would reject every real merge-gate
      // caller, since they all call a LOCAL closure built from the factory, not the
      // factory.
      Literal(node) {
        if (typeof node.value !== "string" || !OUTCOME_VALUES.has(node.value)) return;
        const parent = node.parent;
        if (!parent) return;
        const isCallArgument = parent.type === "CallExpression" && parent.arguments.includes(node);
        const isPropertyValue = parent.type === "Property" && parent.value === node;
        if (isCallArgument || isPropertyValue) satisfied = true;
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
