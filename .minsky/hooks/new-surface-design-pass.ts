// New-surface design-pass scan — mt#4124 (calibration-first).
//
// mt#2421 added the render-path surface so that a PR changing something whose
// purpose is to be LOOKED AT hands the principal something to look at. It checks
// the PR body for a URL or an image. That check cannot distinguish
//
//   "I produced an artifact"   from   "I looked at this surface and judged it".
//
// Per mem#704, a probe that returns the same result whether or not the thing is
// true carries no information — and on the judgment axis, artifact-presence is
// exactly that probe. This module asks the other half.
//
// ## The incident this exists for
//
// mt#3694 / PR #2942 (2026-08-13) shipped the cockpit side peek. It produced two
// browser screenshots of the running surface, served the branch and asserted
// `/api/health` identity so the right build was under test, wrote a reproduce
// recipe into the PR body, and caught a real visual defect that way. The
// render-path check was satisfied — replayed at planning time against the real
// 12,562-byte body and real file list: `applicable: true`, `hasArtifact: true`,
// no warning.
//
// The pane still shipped with zero padding, page-scale typography in a ~416px
// column, and a card border plus a second scrollbar nested inside the pane's own.
// The principal reported it on sight: "its p obviously bad, for instance, there's
// no padding." (Fixed by mt#4123.)
//
// **Why the artifact was produced and the judgment was not.** The screenshots
// were examined against a checklist of the spec's criteria, and the spec's only
// aesthetic criterion was conformance-shaped — "uses the semantic token layer and
// the dark-first elevation convention" — which is satisfiable by reading class
// names. A checklist-driven look at a badly-styled pane returns PASS on every
// item. That is also why the raw-UUID pane title WAS caught and the padding was
// not: the UUID collided with a criterion being held; the padding collided with
// nothing.
//
// ## Why the discriminator is skill invocation and not a spec criterion
//
// The agent authoring the spec is the agent verifying it, in the same session,
// and will author an equally weak criterion — mem#736: self-authorship is an
// AGGRAVATING factor, not a mitigating one. A criterion-tier fix has the same
// problem the criterion had. The discriminator has to be something the agent
// cannot satisfy by writing prose about itself.
//
// `/impeccable` and `/cockpit-design` both exist, are correctly scoped to exactly
// this work (visual hierarchy, spacing, typography, density), and NEITHER was
// invoked at any point across that entire cockpit UI feature — established
// empirically, not assumed: extracting every `Skill` tool_use from the authoring
// conversation (`93e98f39-ab98-47e5-b04b-82b17165f3ad`) yields `plan-task` x2,
// `implement-task`, `retrospective`, `handoff`, and no design skill of any kind.
//
// This mirrors the discriminator the corpus already trusts elsewhere — "was this
// symbol read this turn?" — rather than asking the agent to self-report
// diligence. `/cockpit-design` already carries the load-bearing content: its
// "Verifying a render change, and handing it over (mt#2421)" section prescribes
// exercising the surface as a user, capturing the FULL uncropped render at
// >=1440x900, and presenting it without an aesthetic verdict. The content was
// correct and present; only the invocation was missing. That is the fact this
// keys on.
//
// ## Narrowing: two triggers, because file-add was the wrong proxy (mt#4356)
//
// Skill invocation is too blunt unqualified — a one-line CSS tweak on a render
// path should not demand a design pass. The FIRST version of this module answered
// that by firing only on an ADDED render-path file: `git diff --name-status
// main...HEAD` yields A/M status, so "adds a new user-facing surface" was
// decidable without a semantic guess, and a tweak to an existing component is `M`
// and never fired.
//
// **That proxy misses the largest class of design work: changing how an existing
// surface looks.** mt#4251's entire deliverable was a visual treatment across
// five controls; it MODIFIED two render-path files and added none, so this module
// could not fire, and the principal reported the appearance of the merged result
// — the second instance of exactly the failure this module exists to prevent
// (R1 mem#1026 / mt#3694, R2 mem#1156 / mt#4251). mt#4220, mt#4250, mt#4251 and
// mt#4348 are all `M`-only and all purely visual: the whole cockpit redesign
// sequence was invisible to the detector built for it.
//
// So there are now TWO triggers, and the second carries its own discriminator
// rather than widening the first into "any render-path change":
//
//   1. The branch ADDS a render-path file. Unchanged — a new surface is a design
//      decision by construction. PR #2942 (`PeekBody.tsx`, `PeekHost.tsx`,
//      `ui/sheet.tsx`) still fires here.
//   2. The branch MODIFIES a render-path file AND the bound task's spec declares
//      the change is visually judged — a screenshot criterion, "for the principal
//      to judge", a viewport, a design review. See {@link SPEC_VISUAL_PHRASES}.
//
// Trigger 2's discriminator is the spec rather than the diff because the diff
// cannot answer it: a one-line functional fix and a one-line visual retreatment
// produce identical `M` status and similar hunks, and only the spec says which
// one the author was making. A functional tweak's spec does not ask anyone to
// look at a screenshot. That keeps the false-positive protection the original
// narrowing was written for, without keeping its blind spot.
//
// ## Posture: log-only, fail-open, and SILENT on an absent transcript
//
// Log-only per ADR-024's ladder — which does not GOVERN this module (it scopes
// itself to `UserPromptSubmit` guidance hooks matching trigger phrases in the
// agent's own output; this is a PreToolUse seam guard reading a diff and a tool
// list) but whose cheapest-sufficient-first discipline is the nearest accepted
// precedent, exactly as the sibling `render-path-evidence.ts` records for itself.
// The fire rate against real render-path PRs is measured before any posture above
// log-only is proposed.
//
// The absent-transcript case is the one that must not be got wrong. With no
// transcript this module cannot see whether a design skill ran, and "I could not
// look" is not "it did not happen" — recording `matched` there would manufacture
// the exact false positive that trains a reader to discount the true ones
// (mem#719). It records `skipped` with a reason instead.
//
// @see mt#4124 — this task
// @see .minsky/hooks/render-path-evidence.ts — mt#2421's merge-time surface, whose
//      `isRenderPathFile` classification this reuses rather than re-deriving. That
//      check stays exactly as it is; this is a sibling, not a replacement.
// @see .minsky/hooks/evidence-provenance-table.ts — `normalizeToolName`, shared
// @see mem#704 — a probe that cannot fail carries no information
// @see mt#4123 — the styling defect that got through

import { isRenderPathFile } from "./render-path-evidence";
import { normalizeToolName } from "./evidence-provenance-table";
import type { TranscriptLine } from "./transcript";
import { CANARY_MODE_ENV, findRepoRoot, DEFAULT_FS, execWithPath } from "./types";
import type { ToolHookInput } from "./types";
import type { DispatchContext, GuardOutcome } from "./registry";

/** Override env var (registered in `HOOK_ONLY_ENV_VARS`). */
export const OVERRIDE_ENV_VAR = "MINSKY_SKIP_NEW_SURFACE_DESIGN_PASS";

/** Cap on surfaces listed in the warning; overflow is always stated. */
export const MAX_REPORTED_SURFACES = 6;

/**
 * Skills that constitute a design pass.
 *
 * Enumerated rather than pattern-matched: this is a fixed, small, in-repo set,
 * and a regex over skill names would be a paraphrase axis where none is needed.
 * A skill added to the tree later does not silently join — which is the correct
 * default, since joining this list is a decision about what counts as design
 * review, not a naming coincidence.
 *
 * `product-thinking` is included because it is the layer ABOVE the render
 * question ("what should this surface BE?"), and a surface derived through it has
 * had the more expensive version of the same look.
 */
export const DESIGN_SKILLS: readonly string[] = [
  "impeccable",
  "cockpit-design",
  "frontend-design",
  "interface-design",
  "web-design-guidelines",
  "product-thinking",
];

/**
 * Normalize a skill name as written at the call site.
 *
 * Handles the three spellings the harness accepts for one skill: a bare name, a
 * leading slash (`/impeccable`), and a plugin-qualified name (`plugin:skill`).
 * Case is folded because skill names are matched, not displayed.
 */
export function normalizeSkillName(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  const withoutSlash = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const colon = withoutSlash.lastIndexOf(":");
  return colon >= 0 ? withoutSlash.slice(colon + 1) : withoutSlash;
}

/**
 * Phrases by which a spec DECLARES that its change is judged by eye (mt#4356).
 *
 * This is trigger 2's whole discriminator, so its failure directions are worth
 * naming. A false NEGATIVE (a visual task whose spec uses none of these) leaves
 * the pre-mt#4356 blind spot in place for that task — no worse than before. A
 * false POSITIVE fires a log-only advisory on a functional change, which costs a
 * line in a calibration record. The asymmetry is deliberate: the list stays
 * literal and small rather than reaching for coverage it cannot verify.
 *
 * Enumerated, not regex-matched, for the same reason {@link DESIGN_SKILLS} is:
 * this is a claim about how specs in THIS repo are written, and the honest way to
 * widen it is a measured replay, not a cleverer pattern. Every entry is drawn
 * from a real criterion in the four `M`-only visual specs this task was filed
 * from (mt#4220, mt#4250, mt#4251, mt#4348) — not invented.
 */
export const SPEC_VISUAL_PHRASES: readonly string[] = [
  "screenshot",
  "for the principal to judge",
  "aesthetic acceptance",
  "viewport",
  "design pass",
  "design review",
  "at rest",
  "looks right",
];

/**
 * Does the bound spec declare that this change is visually judged?
 *
 * Case-folded substring matching over the whole spec. Deliberately NOT scoped to
 * `## Success Criteria`: mt#4251 carried its screenshot requirement in the
 * criteria, but mt#4220 carried the equivalent in `## Approach`, and a scoped
 * match would have missed it — the question is whether the TASK is visual, not
 * which heading the author filed the sentence under.
 */
export function specDeclaresVisualJudgment(specContent: string): boolean {
  const haystack = specContent.toLowerCase();
  return SPEC_VISUAL_PHRASES.some((p) => haystack.includes(p));
}

/** Design skills invoked, given every skill name called in the session. */
export function findDesignSkillsInvoked(skillNames: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of skillNames) {
    const name = normalizeSkillName(raw);
    if (DESIGN_SKILLS.includes(name)) seen.add(name);
  }
  return [...seen];
}

/** True when a tool name is the harness `Skill` tool, however spelled. */
export function isSkillToolName(raw: string): boolean {
  return normalizeToolName(raw) === "skill";
}

/**
 * Every skill name invoked in a transcript.
 *
 * The tool name is compared through {@link isSkillToolName} — i.e. through the
 * SHARED `normalizeToolName` — rather than by string equality.
 *
 * **This walks the lines itself instead of calling `findToolUseInputs` (PR #3030
 * R1).** That helper matches the tool name with `===`, so the first version of
 * this function recognized the literal `"Skill"` and nothing else: a lowercased
 * or MCP-qualified spelling was invisible, and an invisible skill call reads as
 * "no design pass" — a FALSE FIRE, the direction that costs a detector its
 * credibility. The normalizer existed and was exported from this very module;
 * it simply was not on the path that matters, which is the shape the corpus
 * calls a helper with green tests and no production call site.
 *
 * The two transcript shapes handled here mirror `extractToolUseNames`: a
 * top-level `tool_use` line, and a `tool_use` block inside an assistant
 * message's `content` array. Handling only the nested one made top-level-recorded
 * turns invisible in a sibling detector (PR #2584 R1).
 */
export function extractSkillNames(lines: TranscriptLine[]): string[] {
  const names: string[] = [];
  const take = (raw: unknown): void => {
    if (!raw || typeof raw !== "object") return;
    const skill = (raw as Record<string, unknown>)["skill"];
    if (typeof skill === "string" && skill.trim().length > 0) names.push(skill);
  };

  for (const line of lines) {
    if (line.type === "tool_use") {
      const n = line.name ?? line.tool_name;
      if (typeof n === "string" && isSkillToolName(n)) take(line.input);
    }
    const content = line.message?.content;
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (!block || block["type"] !== "tool_use") continue;
        const n = block["name"];
        if (typeof n === "string" && isSkillToolName(n)) take(block["input"]);
      }
    }
  }
  return names;
}

/**
 * What the guard concludes, given everything the shell managed to read.
 *
 * Extracted from `run()` (PR #3030 R1) so every branch is reachable without a
 * git tree, a transcript file, or a patched module import — the functional
 * core / imperative shell split `testing-standards.mdc §Testable Design`
 * prescribes. The absent-transcript rule in particular is the one behavior this
 * module most needs pinned, and it was previously only assertable by mocking IO.
 */
export type DesignPassOutcome =
  | { kind: "clean"; reason?: string }
  | { kind: "skipped"; reason: string }
  | { kind: "matched" };

export function decideOutcome(
  result: NewSurfaceDesignPassResult,
  hasTranscript: boolean
): DesignPassOutcome {
  if (!result.applicable) return { kind: "clean", reason: "no applicable trigger" };

  // LOAD-BEARING ORDER: the transcript check comes AFTER applicability but BEFORE
  // the verdict. An empty transcript means this module could not see whether a
  // design skill ran, and "I could not look" is not "it did not happen" — the
  // whole point of the discriminator is that it reads session state, so with no
  // session state there is no finding to report. Concluding `matched` here would
  // fire on every invocation that reached the guard without a transcript.
  if (!hasTranscript) {
    return { kind: "skipped", reason: "no transcript — skill calls unreadable" };
  }

  if (result.designSkillsInvoked.length > 0) return { kind: "clean" };
  return { kind: "matched" };
}

/** Which of the two triggers made the check applicable (mt#4356). */
export type DesignPassTrigger = "added-surface" | "modified-surface-visual-spec";

/** Result of the new-surface design-pass check. */
export interface NewSurfaceDesignPassResult {
  /** False when neither trigger fired — the check does not apply. */
  applicable: boolean;
  /**
   * The render-path files the applicable trigger is ABOUT — added files for
   * `added-surface`, modified files for `modified-surface-visual-spec`.
   *
   * Named `surfaces` rather than `addedSurfaces` since mt#4356: the old name
   * became a lie the moment a modified file could carry the finding, and a field
   * whose name contradicts its contents is how the next reader inherits the
   * original blind spot.
   */
  surfaces: string[];
  /** Which trigger applied, or null when none did. Rendered in the warning and the record. */
  trigger: DesignPassTrigger | null;
  /** Design skills invoked in the authoring session. */
  designSkillsInvoked: string[];
}

/**
 * The pure core: does this branch put a user-facing surface in front of someone
 * with no design pass behind it?
 *
 * Every input is a list the shell reads — the branch's added and modified files,
 * the session's skill invocations, and whether the bound spec declares the change
 * visually judged — so the whole decision is testable without a git tree, a
 * transcript, or a task-service round trip.
 *
 * Trigger 1 is checked first and wins: when a branch both adds and modifies
 * surfaces, the addition is the stronger signal and needs no spec evidence, so
 * the shell can skip the spec fetch entirely in that case.
 */
export function checkNewSurfaceDesignPass(
  addedFiles: readonly string[],
  modifiedFiles: readonly string[],
  skillNames: readonly string[],
  specIsVisual: boolean
): NewSurfaceDesignPassResult {
  const addedSurfaces = addedFiles.filter((f) => isRenderPathFile(f));
  if (addedSurfaces.length > 0) {
    return {
      applicable: true,
      surfaces: addedSurfaces,
      trigger: "added-surface",
      designSkillsInvoked: findDesignSkillsInvoked(skillNames),
    };
  }

  const modifiedSurfaces = modifiedFiles.filter((f) => isRenderPathFile(f));
  if (modifiedSurfaces.length > 0 && specIsVisual) {
    return {
      applicable: true,
      surfaces: modifiedSurfaces,
      trigger: "modified-surface-visual-spec",
      designSkillsInvoked: findDesignSkillsInvoked(skillNames),
    };
  }

  return { applicable: false, surfaces: [], trigger: null, designSkillsInvoked: [] };
}

/**
 * Split `git diff --name-status` output into added and modified paths.
 *
 * Exported and pure because this is where PR #3189 R1's defect lived: the parse,
 * not the decision. `checkNewSurfaceDesignPass` was always correct given the
 * right lists — the shell was handing it the wrong ones, and a test that only
 * exercised the core could not see that.
 */
export function parseNameStatus(stdout: string): { added: string[]; modified: string[] } {
  const added: string[] = [];
  const modified: string[] = [];
  for (const line of stdout.split("\n")) {
    const parts = line.split("\t");
    const status = parts[0];
    if (!status) continue;

    // A rename emits THREE fields — `R<similarity>\told\tnew` — so the new path
    // is `parts[2]`, and a two-field read would silently take the OLD path.
    // `R100` is a pure move with no content change and stays excluded from both
    // lists, per the original rationale: relocating a component is not designing
    // a surface. Anything below 100 moved AND changed the file, which is a
    // modification of an existing surface and belongs to trigger 2.
    if (status.startsWith("R")) {
      const newPath = parts[2]?.trim();
      const similarity = Number(status.slice(1));
      if (newPath && Number.isFinite(similarity) && similarity < 100) modified.push(newPath);
      continue;
    }

    const path = parts[1]?.trim();
    if (!path) continue;
    if (status === "A") added.push(path);
    else if (status === "M") modified.push(path);
  }
  return { added, modified };
}

/**
 * Files this branch ADDS and MODIFIES, from `git diff --name-status main...HEAD`.
 *
 * `main...HEAD` (three dots) rather than `main..HEAD`: the two-dot form
 * re-reports everything main has done since the branch diverged, which would
 * make this fire on surfaces the PR never touched.
 *
 * Status `A` and `M` are kept SEPARATE, because they feed different triggers —
 * an addition fires on its own, a modification only alongside a visual spec.
 * A rename splits on its similarity score, which is the part the first draft of
 * this change got wrong (PR #3189 R1). A PURE move (`R100`) is counted as
 * NEITHER: relocating a component is not designing a new surface, and counting it
 * would fire on every refactor that shuffles files. A rename BELOW 100 moved and
 * changed the file in one step, which is a modification of an existing surface
 * and feeds trigger 2 — a component moved and restyled together is precisely the
 * design work this module exists to notice, and dropping it would have left a
 * silent hole inside the very trigger mt#4356 added.
 */
function readTouchedFiles(repoRoot: string): {
  added: string[];
  modified: string[];
  failed?: string;
} {
  const res = execWithPath(["git", "diff", "--name-status", "main...HEAD"], {
    cwd: repoRoot,
    timeout: 10_000,
  });
  if (res.timedOut) return { added: [], modified: [], failed: "git diff timed out" };
  if (res.exitCode !== 0) {
    // git's stderr on a failed `diff` is ASCII diagnostic text (ref names,
    // "unknown revision"), and this only ever reaches a calibration record.
    // eslint-disable-next-line custom/no-unsafe-string-truncation -- known-ASCII, see above
    const detail = res.stderr.trim().slice(0, 200);
    return { added: [], modified: [], failed: `git diff exited ${res.exitCode}: ${detail}` };
  }
  return parseNameStatus(res.stdout);
}

/** Budget for the spec fetch. Mirrors `inject-success-criteria.ts`'s allowance for the same call. */
const SPEC_FETCH_TIMEOUT_MS = 15_000;

/**
 * Fetches the bound task's spec markdown via the `minsky` CLI (mt#4356).
 *
 * Returns `null` on ANY failure — no task id, a non-zero exit, an unparseable
 * response — and the caller treats `null` as "not visual", which means trigger 2
 * cannot fire. That direction is deliberate: a spec this module could not read is
 * not evidence that the change is visual, and firing on an unreadable spec would
 * make every fetch failure look like a finding.
 *
 * Deliberately NOT imported from `inject-success-criteria.ts`, matching that
 * module's own note about `fetchTaskSpecForAtCoverage`: these hooks are separate
 * processes with separate failure budgets, and a shared helper would couple their
 * timeouts.
 */
function fetchSpecContent(task: string, cwd: string): string | null {
  const res = execWithPath(["minsky", "tasks", "spec", "get", task, "--json"], {
    cwd,
    timeout: SPEC_FETCH_TIMEOUT_MS,
  });
  if (res.timedOut || res.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(res.stdout) as { content?: unknown; task?: { spec?: unknown } };
    const content = parsed.content ?? parsed.task?.spec;
    return typeof content === "string" && content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

/** The bound task id from a `session_pr_create` tool input, when it carries one. */
export function taskIdFromInput(input: ToolHookInput): string | null {
  const raw = input.tool_input?.["task"];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

/**
 * Shaped per `guard-feedback-authoring.mdc`: guard-id header, the evidence that
 * tripped it, an imperative directive, and the branch under which NOT acting is
 * correct.
 */
export function buildDesignPassWarning(
  surfaces: readonly string[],
  trigger: DesignPassTrigger
): string {
  const lines = [
    "[new-surface-design-pass] CALIBRATION (log-only, mt#4124 — would advise if graduated):",
    trigger === "added-surface"
      ? "this branch ADDS a user-facing surface, and no design skill ran while it was built."
      : "this branch CHANGES how an existing surface looks — its spec asks for a visual " +
        "judgment — and no design skill ran while it was built.",
    "",
  ];
  for (const s of surfaces.slice(0, MAX_REPORTED_SURFACES)) lines.push(`  - ${s}`);
  const overflow = surfaces.length - MAX_REPORTED_SURFACES;
  if (overflow > 0) {
    lines.push(`  ... and ${overflow} more (all recorded in the calibration log)`);
  }
  lines.push(
    "",
    "Producing a screenshot is not the same act as judging what is in it. mt#3694 shipped two",
    "browser screenshots of a pane that had no padding, because the screenshots were checked",
    "against criteria that a badly-styled pane satisfies. Invoke `/impeccable` or",
    "`/cockpit-design` and look at the surface against what they ask, before creating the PR.",
    "",
    trigger === "added-surface"
      ? `Leave it if the added file renders no new surface of its own. Override: ${OVERRIDE_ENV_VAR}=1.`
      : `Leave it if the change is functional and the spec's visual language is about something ` +
          `else. Override: ${OVERRIDE_ENV_VAR}=1.`
  );
  return lines.join("\n");
}

function isOverridden(): boolean {
  const v = process.env[OVERRIDE_ENV_VAR];
  return v === "1" || v?.toLowerCase() === "true" || v?.toLowerCase() === "yes";
}

/**
 * Pure-function entry point invoked in-process by `./dispatch-pretooluse.ts`.
 * Returns `null` for silent allow, matching the dispatcher's contract.
 *
 * NEVER denies — see the posture note in the module header.
 */
export async function run(
  input: ToolHookInput,
  ctx: DispatchContext
): Promise<GuardOutcome | null> {
  if (isOverridden()) return null;

  const base = { ts: new Date().toISOString(), sessionId: input.session_id ?? null };

  // Canary isolation (mt#3824 R2): a canary must never depend on the state of a
  // real working tree or a real transcript, neither of which this module controls.
  if (process.env[CANARY_MODE_ENV] === "1") {
    return {
      calibration: {
        ...base,
        surfaces: [],
        outcome: "skipped",
        reason: "canary mode — branch diff and transcript not read",
      },
    };
  }

  const repoRoot = findRepoRoot(process.cwd(), DEFAULT_FS);
  if (!repoRoot) {
    return {
      calibration: { ...base, surfaces: [], outcome: "skipped", reason: "no repo root" },
    };
  }

  const touched = readTouchedFiles(repoRoot);
  if (touched.failed) {
    // A scan that could not run is recorded, so a sustained infra outage is
    // visible in the calibration data rather than reading as a clean pass.
    return {
      calibration: { ...base, surfaces: [], outcome: "skipped", reason: touched.failed },
    };
  }

  // The spec fetch is a CLI round trip, so it runs only when it can change the
  // answer: trigger 1 wins outright, and with no modified render-path file
  // trigger 2 has nothing to apply to. On the common PR — no render-path files at
  // all — this costs nothing (mt#4356).
  const modifiedSurfaces = touched.modified.filter((f) => isRenderPathFile(f));
  const needsSpec =
    touched.added.filter((f) => isRenderPathFile(f)).length === 0 && modifiedSurfaces.length > 0;
  const taskId = needsSpec ? taskIdFromInput(input) : null;
  const specContent = taskId ? fetchSpecContent(taskId, repoRoot) : null;
  const specIsVisual = specContent !== null && specDeclaresVisualJudgment(specContent);

  const result = checkNewSurfaceDesignPass(
    touched.added,
    touched.modified,
    extractSkillNames(ctx.transcriptLines),
    specIsVisual
  );
  const outcome = decideOutcome(result, ctx.transcriptLines.length > 0);

  // Every evaluation is recorded, fired or not, so the MISS rate is measurable
  // rather than only the fire count — a fire-only log cannot support a rung
  // decision (`hook-observers.mdc`).
  const record = {
    ...base,
    surfaces: result.surfaces,
    // Rendered so a calibration reviewer can split the two triggers' rates —
    // they are separate claims about the corpus and a pooled number describes
    // neither (mt#4356).
    trigger: result.trigger,
    designSkillsInvoked: result.designSkillsInvoked,
    outcome: outcome.kind,
    ...(outcome.kind !== "matched" && outcome.reason ? { reason: outcome.reason } : {}),
  };

  if (outcome.kind !== "matched" || result.trigger === null) return { calibration: record };

  return {
    additionalContext: buildDesignPassWarning(result.surfaces, result.trigger),
    calibration: record,
  };
}
