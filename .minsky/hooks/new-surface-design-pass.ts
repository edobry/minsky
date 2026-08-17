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
// ## Narrowing: ADDED surfaces only
//
// Skill invocation is too blunt unqualified — a one-line CSS tweak on a render
// path should not demand a design pass. So this fires only when the branch ADDS a
// render-path file. `git diff --name-status main...HEAD` yields A/M status, so
// "adds a new user-facing surface" is decidable without a semantic guess, and a
// tweak to an existing component is `M` and never fires. PR #2942 added
// `PeekBody.tsx`, `PeekHost.tsx` and `ui/sheet.tsx`, so the worked example
// survives the narrowing.
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
import { findToolUseInputs } from "./transcript";
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

/** Design skills invoked, given every skill name called in the session. */
export function findDesignSkillsInvoked(skillNames: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of skillNames) {
    const name = normalizeSkillName(raw);
    if (DESIGN_SKILLS.includes(name)) seen.add(name);
  }
  return [...seen];
}

/**
 * Every skill name invoked in a transcript.
 *
 * The tool name is compared through the SHARED `normalizeToolName` rather than a
 * local `toLowerCase()` — `Skill` is harness-native and carries no MCP prefix
 * today, but a second normalizer is the rival implementation the planning pass
 * ruled out, and the shared one is already the corpus's answer to "is this the
 * same tool spelled differently?"
 */
export function extractSkillNames(lines: TranscriptLine[]): string[] {
  const names: string[] = [];
  for (const input of findToolUseInputs(lines, "Skill")) {
    const skill = input["skill"];
    if (typeof skill === "string" && skill.trim().length > 0) names.push(skill);
  }
  return names;
}

/** True when a tool name is the harness `Skill` tool, however spelled. */
export function isSkillToolName(raw: string): boolean {
  return normalizeToolName(raw) === "skill";
}

/** Result of the new-surface design-pass check. */
export interface NewSurfaceDesignPassResult {
  /** False when the branch adds no render-path file — the check does not apply. */
  applicable: boolean;
  /** Render-path files this branch ADDS (status `A`), not merely modifies. */
  addedSurfaces: string[];
  /** Design skills invoked in the authoring session. */
  designSkillsInvoked: string[];
}

/**
 * The pure core: does this branch add a user-facing surface with no design pass?
 *
 * Both inputs are lists the shell reads — the branch's added files and the
 * session's skill invocations — so the whole decision is testable without a git
 * tree or a transcript.
 */
export function checkNewSurfaceDesignPass(
  addedFiles: readonly string[],
  skillNames: readonly string[]
): NewSurfaceDesignPassResult {
  const addedSurfaces = addedFiles.filter((f) => isRenderPathFile(f));
  if (addedSurfaces.length === 0) {
    return { applicable: false, addedSurfaces: [], designSkillsInvoked: [] };
  }
  return {
    applicable: true,
    addedSurfaces,
    designSkillsInvoked: findDesignSkillsInvoked(skillNames),
  };
}

/**
 * Files this branch ADDS, from `git diff --name-status main...HEAD`.
 *
 * `main...HEAD` (three dots) rather than `main..HEAD`: the two-dot form
 * re-reports everything main has done since the branch diverged, which would
 * make this fire on surfaces the PR never added.
 *
 * Only status `A` is kept. A rename (`R`) is deliberately NOT counted as an
 * addition: moving an existing component is not designing a new surface, and
 * counting it would fire on every refactor that relocates a file.
 */
function readAddedFiles(repoRoot: string): { files: string[]; failed?: string } {
  const res = execWithPath(["git", "diff", "--name-status", "main...HEAD"], {
    cwd: repoRoot,
    timeout: 10_000,
  });
  if (res.timedOut) return { files: [], failed: "git diff timed out" };
  if (res.exitCode !== 0) {
    // git's stderr on a failed `diff` is ASCII diagnostic text (ref names,
    // "unknown revision"), and this only ever reaches a calibration record.
    // eslint-disable-next-line custom/no-unsafe-string-truncation -- known-ASCII, see above
    const detail = res.stderr.trim().slice(0, 200);
    return { files: [], failed: `git diff exited ${res.exitCode}: ${detail}` };
  }
  const files: string[] = [];
  for (const line of res.stdout.split("\n")) {
    const [status, path] = line.split("\t");
    if (status === "A" && path) files.push(path.trim());
  }
  return { files };
}

/**
 * Shaped per `guard-feedback-authoring.mdc`: guard-id header, the evidence that
 * tripped it, an imperative directive, and the branch under which NOT acting is
 * correct.
 */
export function buildDesignPassWarning(surfaces: readonly string[]): string {
  const lines = [
    "[new-surface-design-pass] CALIBRATION (log-only, mt#4124 — would advise if graduated):",
    "this branch ADDS a user-facing surface, and no design skill ran while it was built.",
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
    `Leave it if the added file renders no new surface of its own. Override: ${OVERRIDE_ENV_VAR}=1.`
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
        addedSurfaces: [],
        outcome: "skipped",
        reason: "canary mode — branch diff and transcript not read",
      },
    };
  }

  const repoRoot = findRepoRoot(process.cwd(), DEFAULT_FS);
  if (!repoRoot) {
    return {
      calibration: { ...base, addedSurfaces: [], outcome: "skipped", reason: "no repo root" },
    };
  }

  const added = readAddedFiles(repoRoot);
  if (added.failed) {
    // A scan that could not run is recorded, so a sustained infra outage is
    // visible in the calibration data rather than reading as a clean pass.
    return {
      calibration: { ...base, addedSurfaces: [], outcome: "skipped", reason: added.failed },
    };
  }

  const result = checkNewSurfaceDesignPass(added.files, extractSkillNames(ctx.transcriptLines));

  // Every evaluation is recorded, fired or not, so the MISS rate is measurable
  // rather than only the fire count — a fire-only log cannot support a rung
  // decision (`hook-observers.mdc`).
  if (!result.applicable) {
    return {
      calibration: { ...base, addedSurfaces: [], outcome: "clean", reason: "no added surface" },
    };
  }

  const record = {
    ...base,
    addedSurfaces: result.addedSurfaces,
    designSkillsInvoked: result.designSkillsInvoked,
  };

  // LOAD-BEARING ORDER: the transcript check comes AFTER applicability but BEFORE
  // the verdict. An empty transcript means this module could not see whether a
  // design skill ran, and "I could not look" is not "it did not happen" — the
  // whole point of the discriminator is that it reads session state, so with no
  // session state there is no finding to report. Recording `matched` here would
  // fire on every invocation that reached the guard without a transcript.
  if (ctx.transcriptLines.length === 0) {
    return {
      calibration: {
        ...record,
        outcome: "skipped",
        reason: "no transcript — skill calls unreadable",
      },
    };
  }

  if (result.designSkillsInvoked.length > 0) {
    return { calibration: { ...record, outcome: "clean" } };
  }

  return {
    additionalContext: buildDesignPassWarning(result.addedSurfaces),
    calibration: { ...record, outcome: "matched" },
  };
}
