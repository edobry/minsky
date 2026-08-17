// mt#3957: structural guardrail + executable acceptance tests for /create-task's
// claim-verification steps (§2a dependency claims, §2b flakiness attributions,
// §2c causal root causes).
//
// Two jobs, deliberately in one file:
//
//  1. MANIFEST — every claim-verification step that has shipped must remain
//     present, at its own letter, in BOTH the source skill and the generated
//     `.claude/skills/create-task/SKILL.md` that agents actually consume. Same
//     invariant (and same rationale) as `plan-task-gate-letters.test.ts`: mt#2445
//     silently deleted a /plan-task gate by reusing its letter, with no duplicate
//     to detect. A "no duplicates" check would not have caught it; a manifest does.
//
//  2. ACCEPTANCE REPLAY — mt#3957's five acceptance tests are all of the form
//     "this spec text passes / fails §2c." That is only checkable if the
//     condition is executable, so `satisfiesEmissionSiteCheck` below encodes it.
//     It is a TEST HARNESS, not a shipped guard: §2c ships as prompt-time prose,
//     and whether a deterministic sibling ships deny-tier is an enforcement-POSTURE
//     call reserved to the operator (mt#3769). If that guard is later approved,
//     this predicate is what it should be built from.

/* eslint-disable custom/no-real-fs-in-tests -- this test's PURPOSE is to verify the
   generated .claude/skills/create-task/SKILL.md artifact on disk matches the source,
   so it must read the real generated file. Same carve-out, same reason, as
   tests/domain/plan-task-gate-letters.test.ts. */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE_SKILL_PATH = join(import.meta.dir, "../../.minsky/skills/create-task/SKILL.md");
const GENERATED_SKILL_PATH = join(import.meta.dir, "../../.claude/skills/create-task/SKILL.md");

const SOURCE = readFileSync(SOURCE_SKILL_PATH, "utf8") as string;
const GENERATED = readFileSync(GENERATED_SKILL_PATH, "utf8") as string;

// Append-only manifest: [step id, exact heading title] for EVERY lettered sub-step
// in the skill, not only the claim-verification ones — the silent-deletion invariant
// applies to all of them equally, and scoping the manifest narrower would leave the
// others unprotected for no benefit. Adding a step = APPEND a row. Never reuse or
// reword a row without a deliberate manifest update — the brittleness IS the guard.
const EXPECTED_STEPS: string[][] = [
  ["1a", "Check whether the task already exists"],
  ["2a", "Verify load-bearing dependency claims"],
  ["2b", 'Record the isolation control before filing a "flaky" task'],
  ["2c", "Cite the emission site before asserting a root cause"],
  // mt#3855 (R6): a criterion that reserves a decision to the principal must quote the
  // reserving ACT, or be rephrased so it cannot gate a merge. Appended, not inserted —
  // the manifest is append-only, and CI is what caught the omission: adding §2d to the
  // skill without registering it here failed both manifest tests (13,989 pass / 2 fail).
  ["2d", "A criterion that reserves a decision to the principal needs the reserving ACT"],
];

// Headings look like: `### 2c. Cite the emission site before asserting a root cause (mt#3957)`.
// The trailing task tag is OPTIONAL (PR #2846 R1): every current step carries one, but a
// future step added without it would vanish from the manifest silently — the manifest would
// simply not see the heading, which is the exact silent-deletion failure this guard exists to
// catch, reintroduced through the parser.
const STEP_HEADING = /^[ \t]*### (\d[a-z])\.\s+(.+?)(?:\s*\(mt#\d+\))?\s*$/gm;

function parseSteps(content: string): string[][] {
  return [...content.matchAll(STEP_HEADING)].map((m) => [m[1] as string, m[2] as string]);
}

// ---------------------------------------------------------------------------
// §2c's checkable condition, as an executable predicate (the AT harness)
// ---------------------------------------------------------------------------

/**
 * Confident-cause labels from §2c's trigger list. Deliberately NOT including the
 * bare word "because": it appears in most prose, so triggering on it would fire
 * §2c on nearly every spec and break the proportionality the step promises.
 */
const CAUSAL_CLAIM_PATTERN =
  /\broot cause\b|\bcause confirmed\b|\bdiagnosis \(definitive\)\b|\bthe reason is\b|\bcaused by\b/i;

/**
 * Strip URLs before looking for a `path:line`. Without this, `https://db.example.com:5432`
 * satisfies the citation check: `example` + `.com` + `:5432` matches the path:line shape
 * exactly, so a spec that asserts a cause and happens to mention a hosted endpoint would
 * pass §2c having cited no emission site at all (PR #2846 R1, BLOCKING).
 *
 * Stripping by SCHEME rather than blacklisting `https` covers the whole class — `postgres://`,
 * `redis://`, `ws://` and any future scheme fail the same way for the same reason.
 */
function stripUrls(text: string): string {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ");
}

/**
 * A `path/to/file.ext:123` reference — the emission site's required form.
 *
 * The extension segment is deliberately permissive (`.json5`, `.graphql`, `.proto`, and the
 * `.ts` of a `.d.ts` all qualify) rather than a curated list that would silently reject a
 * legitimate citation in a language the list forgot (PR #2846 R1, NON-BLOCKING). Over-matching
 * is safe HERE only because {@link stripUrls} has already removed the one over-match that
 * mattered; the leading `[\w./\\-]` class also admits Windows separators.
 */
const PATH_LINE_PATTERN = /[\w./\\-]*[\w-]\.[a-z][a-z0-9]{0,7}:\d+/i;

/** Wording that states the asserted cause's branch reaches the cited line. */
const REACHABILITY_PATTERN = /\breach(?:es|ed|able)?\b|\bfalls (?:to|through)\b|\bcontrol falls\b/i;

/** The literal opt-out marker. */
const UNVERIFIED_PATTERN = /\bUNVERIFIED\b/;

export interface EmissionSiteVerdict {
  /** Did the spec make a causal claim at all? If not, §2c does not fire. */
  triggered: boolean;
  /** True when §2c is satisfied (or never fired). */
  satisfied: boolean;
  reason: string;
}

/**
 * Evaluate a drafted spec's text against §2c. Both halves of the citation are
 * required: a `path:line` ALONE does not establish that the asserted cause's
 * branch reaches it, and reachability prose alone cites nothing.
 */
export function satisfiesEmissionSiteCheck(specText: string): EmissionSiteVerdict {
  if (!CAUSAL_CLAIM_PATTERN.test(specText)) {
    return { triggered: false, satisfied: true, reason: "no causal claim — §2c does not fire" };
  }
  if (UNVERIFIED_PATTERN.test(specText)) {
    return { triggered: true, satisfied: true, reason: "cause marked UNVERIFIED" };
  }
  const hasPathLine = PATH_LINE_PATTERN.test(stripUrls(specText));
  const hasReachability = REACHABILITY_PATTERN.test(specText);
  if (hasPathLine && hasReachability) {
    return { triggered: true, satisfied: true, reason: "emission site cited with reachability" };
  }
  return {
    triggered: true,
    satisfied: false,
    reason: hasPathLine
      ? "path:line cited but no reachability statement"
      : "causal claim with no emission-site citation and no UNVERIFIED marker",
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * mt#3955's WRONG original diagnosis, reconstructed from the record its corrected
 * spec preserves (`## ROOT CAUSE — … The earlier diagnosis in this spec was WRONG`,
 * plus mt#3957's own account). The byte-exact original was overwritten by the
 * correction, so this is a faithful reconstruction of its shape and evidence —
 * which is what §2c is being replayed against — not a recovered artifact.
 */
const MT3955_ORIGINAL_WRONG = `
## Cause CONFIRMED

The guarded delete refused and the refusal was swallowed. Calling \`session_delete\`
on the abandoned session returns a refusal naming the live-actor gate, so
\`session_start --recover\` hits the same gate and the error is re-emitted.
`;

/** The corrected section, verbatim-shaped from mt#3955's shipped spec. */
const MT3955_CORRECTED = `
## ROOT CAUSE — verified 2026-08-11. The earlier diagnosis in this spec was WRONG.

**\`SessionService.start\` drops the \`recover\` flag.** \`packages/domain/src/session/session-service.ts:125-139\`
builds \`sessionStartParams\` field by field and never copies \`recover\`.

\`start-session-operations.ts:401\` guards the recover branch on
\`(liveness === "stale" || "orphaned") && params.recover\`. With \`recover\` falsy,
control falls to the \`else\` at \`:458\` and reaches \`:480\` — which emits the
abandoned-session error verbatim. So the recover path was never entered at all.
`;

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe("create-task claim-step manifest (mt#3957)", () => {
  test("source skill defines exactly the expected steps, in order (append-only)", () => {
    expect(parseSteps(SOURCE)).toEqual(EXPECTED_STEPS);
  });

  test("generated SKILL.md matches the same manifest (also catches a stale compile)", () => {
    expect(parseSteps(GENERATED)).toEqual(EXPECTED_STEPS);
  });

  test("§2c is wired into the pre-tasks_create gate, not merely documented", () => {
    // A step the Step 4 gate never names is advice, not a gate — which is how §2b
    // shipped (its omission from that list is tracked separately).
    const gateBlock = SOURCE.slice(SOURCE.indexOf("**Gate:** before calling"));
    expect(gateBlock).toContain("Step 2c");
    expect(gateBlock).toContain("EMISSION");
  });

  test("§2d is wired into the pre-tasks_create gate, not merely documented", () => {
    // Same bar §2c is held to, applied to mt#3855's step at the moment it lands rather
    // than after a recurrence: §2b shipped unwired and that omission had to be tracked
    // separately, so a new step registers in the gate list and here in the same change.
    const gateBlock = SOURCE.slice(SOURCE.indexOf("**Gate:** before calling"));
    expect(gateBlock).toContain("Step 2d");
    expect(gateBlock).toContain("reserving ACT");
  });

  test("a step heading without an (mt#NNNN) tag is still parsed (PR #2846 R1)", () => {
    // If the parser required the tag, a future untagged step would be invisible to the
    // manifest — reintroducing the silent-deletion failure through the guard itself.
    expect(parseSteps("### 2d. A future step with no task tag\n")).toEqual([
      ["2d", "A future step with no task tag"],
    ]);
  });

  test("§2b's falsified calibration-first rationale is corrected, not left standing", () => {
    // mt#3957's planning audit falsified it; leaving it would let the next sibling
    // inherit the same wrong reason.
    expect(SOURCE).not.toContain(
      "is the one this repo requires to be calibration-first (the mt#2263 ladder:"
    );
    expect(SOURCE).toContain("mechanism-scoped, not surface-scoped");
  });
});

// ---------------------------------------------------------------------------
// Acceptance tests — mt#3957's own numbering
// ---------------------------------------------------------------------------

describe("§2c acceptance replay (mt#3957)", () => {
  test("AT1: a root-cause claim with no emission-site citation and no UNVERIFIED fails", () => {
    const verdict = satisfiesEmissionSiteCheck(
      "The root cause is that the guarded delete refused and the refusal was swallowed."
    );
    expect(verdict.triggered).toBe(true);
    expect(verdict.satisfied).toBe(false);
  });

  test("AT2: the same claim with a path:line emission site plus reachability passes", () => {
    const verdict = satisfiesEmissionSiteCheck(
      "The root cause is the dropped flag. `start-session-operations.ts:481` emits the string, " +
        "and control falls to that branch only when recover is falsy."
    );
    expect(verdict.satisfied).toBe(true);
  });

  test("AT3: the same claim marked UNVERIFIED passes", () => {
    const verdict = satisfiesEmissionSiteCheck(
      "UNVERIFIED as caused by the swallowed refusal — emission site not read."
    );
    expect(verdict.triggered).toBe(true);
    expect(verdict.satisfied).toBe(true);
  });

  test("AT4: a spec with no causal claim is unaffected — §2c does not fire", () => {
    const verdict = satisfiesEmissionSiteCheck(
      "## Summary\n\nAdd a --json flag to the tasks list command so scripts can consume it.\n" +
        "This is a refactor of the output layer; no behavior changes."
    );
    expect(verdict.triggered).toBe(false);
  });

  test("AT5: mt#3955's original diagnosis FAILS §2c; its corrected ROOT CAUSE passes", () => {
    const original = satisfiesEmissionSiteCheck(MT3955_ORIGINAL_WRONG);
    expect(original.triggered).toBe(true);
    expect(original.satisfied).toBe(false);

    const corrected = satisfiesEmissionSiteCheck(MT3955_CORRECTED);
    expect(corrected.satisfied).toBe(true);
  });

  test.each([
    ["https", "https://db.example.com:5432"],
    ["postgres", "postgres://user@host.internal:6543/db"],
    ["ws", "ws://events.example.io:8080/stream"],
  ])("a %s URL with a port is NOT an emission-site citation (PR #2846 R1)", (_scheme, url) => {
    // The blocking finding: `example` + `.com` + `:5432` matches the path:line shape exactly,
    // so without URL-stripping a spec could satisfy §2c while citing no source line at all.
    // Asserted per-scheme because the fix strips by scheme rather than blacklisting one host.
    const verdict = satisfiesEmissionSiteCheck(
      `The root cause is that the connection to ${url} is refused, and control reaches the error path.`
    );
    expect(verdict.satisfied).toBe(false);
    expect(verdict.reason).toContain("no emission-site citation");
  });

  test.each([
    ["packages/domain/src/session/start-session-operations.ts:481"],
    ["src/types/api.d.ts:12"],
    ["schema/user.graphql:9"],
    ["proto/service.proto:145"],
    ["config/settings.json5:22"],
    ["src\\windows\\path.ts:7"],
  ])("%s is accepted as an emission-site citation (PR #2846 R1)", (ref) => {
    // The under-inclusive finding: a curated extension list silently rejects a legitimate
    // citation in whatever language it forgot, which fails CLOSED against the author.
    const verdict = satisfiesEmissionSiteCheck(
      `The root cause is the dropped flag; \`${ref}\` emits the string and the branch reaches it.`
    );
    expect(verdict.satisfied).toBe(true);
  });

  test("a path:line WITHOUT a reachability statement does not satisfy the check", () => {
    // The load-bearing half of §2c: citing the code you believe is at fault proves
    // only that it exists. This is the case the incident actually produced.
    const verdict = satisfiesEmissionSiteCheck(
      "The root cause is the guarded delete in `session-delete-operations.ts:212`."
    );
    expect(verdict.satisfied).toBe(false);
    expect(verdict.reason).toContain("no reachability statement");
  });
});
