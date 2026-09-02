#!/usr/bin/env bun
/**
 * Spec-criterion-claim detector — mt#4153.
 *
 * Thin adapter over `packages/domain/src/detectors/spec-criterion-claim.ts`. The
 * matcher owns the two classes; this file owns the IO: reading the spec text out of
 * the tool call, resolving the authorizing ask for Class B, and writing the
 * evaluation stream.
 *
 * CALIBRATION-FIRST: `INJECTION_ENABLED = false`. The hook writes a calibration
 * record and an evaluation record and injects nothing, per ADR-024's ladder. The
 * flip is a separate, evidence-gated decision after a `/calibration-review` pass
 * over the evaluation stream.
 *
 * ## Which surfaces this fires on, and why Class B is only reachable on some
 *
 * Registered on `tasks_create` AND the two edit surfaces, because the two classes
 * are reachable at different moments:
 *
 *   - Class A works everywhere a spec body is in the payload.
 *   - Class B needs the task's AUTHORIZING ASK, which is an ask whose
 *     `parent_task_id` is that task. At `tasks_create` the task does not exist yet,
 *     so no ask can point at it and Class B cannot fire — which is not a gap but
 *     the spec's own rule (SC2: "If no ask is linked, Class B does not fire: an
 *     unlinked task has no machine-readable authorization to compare against, and
 *     guessing is worse than silence"). The R2 incident it exists for was criteria
 *     written from an already-answered ask, which is an EDIT.
 *
 * ## Why the ask is read by SQL rather than through `asks_list`
 *
 * SC2 prescribes filtering an `asks_list` `summary: true` listing client-side,
 * because that tool exposes no `parentTaskId` filter. That constraint is the MCP
 * tool surface's, not the substrate's: this hook already reaches the database
 * directly (as `duplicate-signature-scan` does), so it can put the filter in a
 * WHERE clause and read one row instead of listing every ask and scanning. Strictly
 * less work for the same answer, and it does not touch `asks_list` at all. Recorded
 * as a deviation in the task spec rather than left as a silent divergence.
 *
 * @see docs/architecture/hooks/spec-criterion-claim-detector.md
 */

import type { ToolHookInput } from "./types";
import { elideMarkdownNonProse } from "./block-out-of-band-merge";
import { describeProviderResolutionFailure, ensureHookDomainBootstrap } from "./domain-bootstrap";
import type { SqlCapablePersistenceProvider } from "../../packages/domain/src/persistence/types";
import {
  detectSpecCriterionClaims,
  elideProseQuotedSpans,
  type AuthorizingSource,
  type SpecCriterionClaimResult,
} from "../../packages/domain/src/detectors/spec-criterion-claim";
import { readAuthoredSpecText, readSpecFileFromDisk } from "./authored-spec-text";
import type { SpecTextRead } from "./authored-spec-text";
import { logEvaluationRecord } from "./dispatcher";
import type { DispatchContext, GuardOutcome } from "./registry";

/**
 * The full elision pass SC7 specifies: markdown non-prose (code spans, fenced
 * blocks, blockquote lines) AND prose-quoted spans.
 *
 * Composed here rather than folded into either half. `elideMarkdownNonProse` is
 * shared with `block-out-of-band-merge`, so widening it to blank quoted prose would
 * change what an unrelated guard sees; and the domain matcher takes its elider as a
 * parameter precisely so the hooks tree owns this wiring (see the matcher's own note
 * on why the elider is injected rather than imported).
 *
 * Both halves pad with same-length whitespace, so composing them preserves the
 * character-for-character raw/elided alignment the referent check reads offsets
 * against.
 */
const SPEC_ELIDER = (text: string): string => elideProseQuotedSpans(elideMarkdownNonProse(text));

/**
 * Injection is OFF during calibration (ADR-024). The flip follows a
 * `/calibration-review` pass over {@link EVALUATION_LOG}, not a judgement here.
 */
export const INJECTION_ENABLED = false;

export const OVERRIDE_ENV_VAR = "MINSKY_SKIP_SPEC_CRITERION_CLAIM";

/**
 * The evaluation stream: one record per examined call, fired or NOT.
 *
 * The calibration log records fires only, so it can measure a false-positive rate
 * and never a MISS rate. This stream is the denominator — how many specs carried
 * criteria, how many carried an authorizing ask — so the question "what is this
 * detector not seeing?" has data behind it (SC5).
 */
const EVALUATION_LOG_NAME = "spec-criterion-claim";

/**
 * Tool-input key carrying the spec body INLINE, per tool.
 *
 * Read off each tool's parameter schema, not inferred from the name — the keys differ
 * by tool and one of them is a trap. `tasks_create` carries the body in `spec` (a
 * string); `tasks_edit` carries it in `specContent`, and its OWN `spec` parameter is
 * a **boolean flag**, not a body (PR #3063 R1 read the two as the same key). A
 * boolean is not scannable, so there is nothing to add for it.
 */
const SPEC_KEY_BY_TOOL: Readonly<Record<string, string>> = {
  tasks_create: "spec",
  tasks_spec_patch: "content",
  tasks_edit: "specContent",
};

/**
 * The `specFile` map, the size ceiling and the defensive disk read that used to live
 * here moved to `./authored-spec-text` (mt#4525).
 *
 * This file is where the hole was first found and patched (PR #3063 R1), and its own
 * comment called it "a silent coverage hole" — then the identical hole was found
 * again in `claim-provenance-scan` (mt#4295) and a third time, worse, in
 * `code-mechanism-assertion-detector` (mt#4525), because each guard carried its own
 * copy. Keeping a private copy HERE is what made it a class. Re-exported below so
 * this module's existing callers and tests are unaffected.
 *
 * The extraction also ADDED something this implementation never had: the shared
 * reader refuses a path outside the repo (mt#4295 SC4). A PreToolUse observer runs
 * against arbitrary tool input, and this one would have read any path it was given.
 */
export { readSpecFileFromDisk };
export type { SpecTextRead };

/** Max chars of a criterion carried into a calibration record. */
const MAX_EXCERPT_CHARS = 200;

/**
 * Read the spec body out of a tool call, or null when this call carries none.
 *
 * Now a thin adapter over the shared resolver (mt#4525). The SCANNING SCOPE stays
 * this detector's own — `SPEC_KEY_BY_TOOL` is passed in rather than merged with the
 * siblings' maps, which deliberately keeps this guard reading the same three tools it
 * always did. Sharing the resolution must not widen anyone's corpus; a widened corpus
 * changes fire rates and confounds the replay each of these guards is calibrated by.
 *
 * The file reader stays a parameter so the `specFile` branch is testable without
 * touching a real filesystem (`testing-standards.mdc §Testable Design` — inject the
 * collaborator rather than patching it).
 */
export function readSpecText(
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined,
  readFile: (path: string) => string | null = readSpecFileFromDisk
): SpecTextRead {
  return readAuthoredSpecText(toolName, toolInput, SPEC_KEY_BY_TOOL, readFile);
}

/**
 * Read the task id, which decides whether Class B can run at all.
 *
 * Absent on `tasks_create` by construction — see the module docblock.
 */
export function readTaskId(toolInput: Record<string, unknown> | undefined): string | null {
  const value = toolInput?.["taskId"];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** The three `asks` columns this lookup selects. */
interface AskRow {
  short_id?: string;
  response?: unknown;
  options?: unknown;
}

/**
 * What a driver's `execute` may hand back: the rows themselves, or a wrapper
 * carrying them. Declared rather than asserted, so the row type survives.
 */
type DbRows<T> = readonly T[] | { rows?: readonly T[] };

/** The shape a resolver must satisfy; injected so tests need no database. */
export type ResolveAuthorizingSource = (taskId: string) => Promise<AuthorizingSource | null>;

/**
 * Resolve the authorizing ask from the database.
 *
 * Reads the most recently answered ask whose `parent_task_id` is this task, and
 * returns its chosen option's label plus that option's description — the
 * operator's own words. Anything absent from them is the agent's addition.
 *
 * Returns null on any failure, which makes Class B silent rather than wrong: a
 * detector that cannot read the authorization must not guess at it.
 */
export async function resolveAuthorizingSourceFromDb(
  taskId: string
): Promise<AuthorizingSource | null> {
  try {
    await ensureHookDomainBootstrap();
    const { resolvePersistenceProviderOrError } = await import(
      "../../packages/domain/src/persistence/factory"
    );
    const resolution = await resolvePersistenceProviderOrError();
    if (!resolution.ok) {
      process.stderr.write(
        `[spec-criterion-claim-detector] ${describeProviderResolutionFailure(resolution)}\n`
      );
      return null;
    }
    const provider = resolution.provider;
    const db = await (provider as SqlCapablePersistenceProvider).getDatabaseConnection();
    // Silent rather than wrong: a resolver that cannot read the authorization must
    // not guess at it, and Class B is skipped when the source is null.
    if (!db) return null;
    const { sql } = await import("drizzle-orm");

    const executed: DbRows<AskRow> = await db.execute(sql`
      select short_id, response, options
      from asks
      where parent_task_id = ${taskId}
        and response is not null
      order by responded_at desc nulls last
      limit 1
    `);

    // Drivers differ on whether `execute` returns the rows or a wrapper carrying
    // them, so both shapes are DECLARED in `DbRows` rather than asserted away with
    // an `as unknown` that would erase the row type too.
    // `Array.isArray` widens a readonly array to `any[]`, so it does not narrow the
    // union usefully here; each branch is asserted to its own declared shape rather
    // than routed through `as unknown`, which would erase `AskRow` too.
    const list: readonly AskRow[] = Array.isArray(executed)
      ? (executed as readonly AskRow[])
      : ((executed as { rows?: readonly AskRow[] }).rows ?? []);
    const row = list[0];
    if (!row) return null;

    return buildAuthorizingSource(row.short_id, row.response, row.options);
  } catch (err) {
    process.stderr.write(
      `[spec-criterion-claim-detector] ask lookup failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }
}

/**
 * Assemble the source from a raw ask row.
 *
 * Exported for tests: the label→description join is the part worth pinning, since
 * the description routinely carries the real constraint and reading only the label
 * would fire on authorized work.
 */
export function buildAuthorizingSource(
  shortId: unknown,
  response: unknown,
  options: unknown
): AuthorizingSource | null {
  const chosen = (response as { payload?: { chosen?: unknown } } | null)?.payload?.chosen;
  if (typeof chosen !== "string" || chosen.trim() === "") return null;

  let description = "";
  if (Array.isArray(options)) {
    for (const option of options) {
      const o = option as { label?: unknown; value?: unknown; description?: unknown };
      if (o.label === chosen || o.value === chosen) {
        if (typeof o.description === "string") description = o.description;
        break;
      }
    }
  }

  return {
    askId: typeof shortId === "string" && shortId !== "" ? shortId : "an ask on this task",
    chosen,
    description,
  };
}

/**
 * The advisory text, built even while injection is off so the registry's
 * `renderProbe` can measure a real ceiling (mt#4002).
 *
 * Shape per `guard-feedback-authoring.mdc`: guard-id header, quoted evidence,
 * imperative directive, legitimate-halt branch. Each class gets its OWN directive —
 * a shared one would tell a Class A author to go read an ask, which is not the
 * remedy for an unverified corpus claim.
 */
export function buildInjectionReminder(result: SpecCriterionClaimResult): string {
  const lines: string[] = [
    "[spec-criterion-claim] A success criterion asserts something unchecked.",
  ];
  lines.push("");
  for (const f of result.findings) {
    lines.push(`  - class ${f.klass} (${f.section}): "${f.phrase}"`);
    lines.push(`      ${f.criterion}`);
  }
  lines.push("");

  const hasA = result.findings.some((f) => f.klass === "A");
  const hasB = result.findings.some((f) => f.klass === "B");

  if (hasA) {
    lines.push(
      "Class A asserts the repo ALREADY contains something. Run the one-line check now and put it",
      "in the criterion, or rewrite the criterion so it does not depend on unverified corpus state."
    );
  }
  if (hasB) {
    const askId = result.findings.find((f) => f.klass === "B")?.askId ?? "the authorizing ask";
    lines.push(
      `Class B imposes a precondition ${askId} does not contain. Re-read what was actually chosen,`,
      "verbatim, and either drop the gate or cite where the authorization says it."
    );
  }

  lines.push(
    "",
    "If the criterion is right as written — the check was run this turn, or the precondition is",
    "authorized somewhere the matcher cannot see — say which in one line and keep it."
  );
  return lines.join("\n");
}

/**
 * Worst-case render for the registry's `renderProbe` (mt#4002).
 *
 * Saturated on EVERY axis at once: both class directives present simultaneously,
 * and the finding list carrying criteria at the matcher's 160-char excerpt cap with
 * a phrase at a representative length.
 *
 * **The finding-count axis is NOT capped** — one block per flagged criterion, and a
 * spec may carry many — so this is a saturated SAMPLE, not a proved ceiling, and
 * `guard-feedback-shape.test.ts` classifies it `render-probe-sample`. It owes an
 * `…and N more` cap before this guard's injection is enabled; posed here at 6,
 * which is above the observed criteria count of the two replay specs.
 */
export function renderWorstCase(): string {
  const criterion = "x".repeat(160);
  const phrase = "once the ADR is accepted";
  return buildInjectionReminder({
    matched: true,
    criteriaExamined: 6,
    authorizingSourceAvailable: true,
    findings: Array.from({ length: 6 }, (_, i) => ({
      section: i % 2 === 0 ? "Success Criteria" : "Acceptance Tests",
      criterion,
      klass: i % 2 === 0 ? "A" : "B",
      phrase,
      condition: "accepted",
      askId: "ask#8467",
    })),
  });
}

function isOverridden(): string | undefined {
  const value = process.env[OVERRIDE_ENV_VAR];
  if (value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes") {
    return value;
  }
  return undefined;
}

// mt#4752: routed through the shared helper, which derives the filename from
// the stream NAME. This also fixes a live instance of the bug mt#3745 removed
// elsewhere: the previous body resolved `resolve(cwd, relPath)` with NO
// `findRepoRoot`, so a hook running with a repo SUBDIRECTORY as its cwd wrote
// its evaluation log into a stray nested `.minsky/` there. Every sibling
// writer already called `findRepoRoot`; this one did not.
function appendEvaluationRecord(cwd: string, record: Record<string, unknown>): void {
  logEvaluationRecord(EVALUATION_LOG_NAME, record, { fallbackCwd: cwd });
}

/**
 * Evaluate one tool call. Returns the result plus the evaluation record that is
 * written whether or not it fired.
 *
 * The ask resolver is INJECTED rather than reached for, so a test can exercise the
 * whole pipeline — extraction, elision, both classes, the evaluation record —
 * without a database and without patching a collaborator
 * (`testing-standards.mdc §Testable Design`).
 */
export async function evaluateCall(
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined,
  resolveSource: ResolveAuthorizingSource,
  readFile: (path: string) => string | null = readSpecFileFromDisk
): Promise<{ result: SpecCriterionClaimResult; evaluation: Record<string, unknown> } | null> {
  const read = readSpecText(toolName, toolInput, readFile);

  // A named-but-unreadable `specFile` is a MISS, not a call that carried no spec, so
  // it gets an evaluation record rather than a silent `null` (SC5 — the stream is the
  // miss denominator, and a hole it cannot see is a hole nothing will measure).
  if (read.text === null) {
    if (!read.specFileUnreadable) return null;
    const empty = detectSpecCriterionClaims("", null, SPEC_ELIDER);
    return {
      result: empty,
      evaluation: {
        timestamp: new Date().toISOString(),
        tool: toolName,
        fired: false,
        criteriaExamined: 0,
        authorizingSourceAvailable: false,
        taskIdPresent: readTaskId(toolInput) !== null,
        classACount: 0,
        classBCount: 0,
        specChars: 0,
        specFileUnreadable: true,
      },
    };
  }

  const spec = read.text;
  const taskId = readTaskId(toolInput);
  // Class B needs an authorization to compare against; absent a task id there can
  // be no linked ask, so the lookup is not even attempted.
  const source = taskId === null ? null : await resolveSource(taskId);

  const result = detectSpecCriterionClaims(spec, source, SPEC_ELIDER);

  const evaluation: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    tool: toolName,
    fired: result.matched,
    criteriaExamined: result.criteriaExamined,
    authorizingSourceAvailable: result.authorizingSourceAvailable,
    taskIdPresent: taskId !== null,
    classACount: result.findings.filter((f) => f.klass === "A").length,
    classBCount: result.findings.filter((f) => f.klass === "B").length,
    specChars: spec.length,
  };

  return { result, evaluation };
}

/** Injectable deps for {@link run} — tests substitute the ask resolver. */
export interface SpecCriterionClaimDeps {
  resolveSource?: ResolveAuthorizingSource;
}

/** Dispatcher entry point (ADR-028 D1/D2). */
export async function run(
  input: ToolHookInput,
  _ctx: DispatchContext,
  deps: SpecCriterionClaimDeps = {}
): Promise<GuardOutcome | null> {
  const override = isOverridden();
  if (override) {
    return {
      auditLines: [
        `[spec-criterion-claim-detector] OVERRIDE: ack=${override} session=${input.session_id ?? "unknown"} ts=${new Date().toISOString()}\n`,
      ],
    };
  }

  let evaluated: Awaited<ReturnType<typeof evaluateCall>>;
  try {
    evaluated = await evaluateCall(
      input.tool_name,
      input.tool_input,
      deps.resolveSource ?? resolveAuthorizingSourceFromDb
    );
  } catch (err) {
    process.stderr.write(
      `[spec-criterion-claim-detector] Detection error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }
  if (!evaluated) return null;

  appendEvaluationRecord(input.cwd ?? process.cwd(), {
    ...evaluated.evaluation,
    session_id: input.session_id,
  });

  if (!evaluated.result.matched) return null;

  // The calibration record is RETURNED, not written here: the dispatcher owns that
  // write for a dispatched guard (`calibrationLog` on the registration), and
  // writing it from both places would double-count every fire — the shape that
  // makes a rate un-measurable. The EVALUATION stream above is different: the
  // dispatcher knows nothing about it, so this path owns that write.
  const outcome: GuardOutcome = {
    calibration: {
      timestamp: new Date().toISOString(),
      session_id: input.session_id,
      tool: input.tool_name,
      findings: evaluated.result.findings.map((f) => ({
        klass: f.klass,
        section: f.section,
        phrase: f.phrase,
        criterion: f.criterion.slice(0, MAX_EXCERPT_CHARS),
        condition: f.condition,
        askId: f.askId,
      })),
      criteriaExamined: evaluated.result.criteriaExamined,
      authorizingSourceAvailable: evaluated.result.authorizingSourceAvailable,
    },
  };

  if (INJECTION_ENABLED) {
    outcome.additionalContext = buildInjectionReminder(evaluated.result);
  }

  return outcome;
}

// No standalone `main()`, deliberately: this guard is DISPATCHED only.
//
// It says nothing about a shebang, because this file HAS one — line 1, written here,
// and carried into the generated copy ahead of the compile banner. An earlier version
// of this comment claimed "and no shebang, deliberately", which contradicted its own
// line 1 (PR #3063 R1). The first attempt to explain that away was also wrong: the
// compiler does not add the shebang, it preserves the one the source already has.
//
// Keeping it matches the siblings (`claim-provenance-scan`,
// `flakiness-control-detector` and `negative-existence-claim-detector` all carry one;
// `duplicate-signature-scan` does not, so both forms exist here). It is harmless
// either way — what makes this guard dispatch-only is the absent entry point below,
// not the interpreter line above.
//
// The registry supplies `module: () => import(...).then((m) => ({ run }))`,
// so the dispatcher is the entry point and a second one would be dead weight —
// plus it would need a synthetic `DispatchContext` this guard never reads, which is
// an `as unknown` cast standing in for a contract that does not apply. Guards that
// ALSO run standalone (`negative-existence-claim-detector`) keep a `main()` because
// they are registered on a host event directly; this one is not.
