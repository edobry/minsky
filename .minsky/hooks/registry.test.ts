import { describe, test, expect } from "bun:test";
// eslint-disable-next-line custom/no-real-fs-in-tests -- the mt#3823 parity block asserts against the REAL committed `.claude/settings.json`, which is the artifact under test: an injected or in-memory copy could not detect the live file losing a dispatcher registration, which is the entire defect class (two guards registered and never invoked). Same shape as the migration-journal read in tests/integration/short-id-conflict-inference.integration.test.ts — reading a committed source of truth, not faking test state.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getGuardsForEvent,
  findDuplicateRegistrations,
  isIntentionalPair,
  INTENTIONAL_MATCHER_PAIRS,
  GUARD_REGISTRY,
  NON_TOOL_SCOPED_EVENTS,
  type GuardRegistration,
  type LifecycleEvent,
} from "./registry";
import { deriveDispatchTimeoutMs, DISPATCH_TIMEOUT_MARGIN_MS } from "./dispatch-timeout-budget";
import { TASK_CREATE_GUARDS } from "./registry-task-create-guards";
import { PR_CREATE_GUARDS } from "./registry-pr-create-guards";
import { COMMAND_STRING_GUARDS } from "./registry-command-string-guards";
import { DELEGATION_GUARDS } from "./registry-delegation-guards";
import { PROMPT_INJECTION_GUARDS } from "./registry-prompt-injection-guards";
import { PROMPT_SCAN_GUARDS } from "./registry-prompt-scan-guards";
import { TURN_END_GUARDS } from "./registry-turn-end-guards";

/** Representative non-tool-scoped event, used across the matcher-less-registration tests. */
const NON_TOOL_EVENT: LifecycleEvent = "UserPromptSubmit";

function makeReg(overrides: Partial<GuardRegistration> = {}): GuardRegistration {
  return {
    name: "test-guard",
    event: "PreToolUse",
    module: () => Promise.resolve({ run: () => null }),
    timeoutMs: 5000,
    denyCapable: true,
    effects: [
      {
        effect: "deny",
        verdictShape: "validator",
        failurePolicy: { failurePolicy: "closed", degradedPolicy: "closed" },
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getGuardsForEvent
// ---------------------------------------------------------------------------

describe("getGuardsForEvent", () => {
  test("matches by event and matcher regex", () => {
    const regs = [
      makeReg({ name: "a", event: "PreToolUse", matcher: "Bash|mcp__minsky__session_exec" }),
      makeReg({ name: "b", event: "PreToolUse", matcher: "Edit|Write" }),
    ];
    expect(getGuardsForEvent(regs, "PreToolUse", "Bash").map((r) => r.name)).toEqual(["a"]);
    expect(getGuardsForEvent(regs, "PreToolUse", "Edit").map((r) => r.name)).toEqual(["b"]);
    expect(getGuardsForEvent(regs, "PreToolUse", "Read")).toEqual([]);
  });

  test("registration with no matcher always matches once event matches (no toolName needed)", () => {
    const regs = [makeReg({ name: "always", event: NON_TOOL_EVENT, matcher: undefined })];
    expect(getGuardsForEvent(regs, NON_TOOL_EVENT).map((r) => r.name)).toEqual(["always"]);
  });

  test("registration WITH a matcher but no toolName supplied does not match", () => {
    const regs = [makeReg({ name: "a", event: "PreToolUse", matcher: "Bash" })];
    expect(getGuardsForEvent(regs, "PreToolUse")).toEqual([]);
  });

  test("non-matching event is excluded", () => {
    const regs = [makeReg({ name: "a", event: "PostToolUse", matcher: "Bash" })];
    expect(getGuardsForEvent(regs, "PreToolUse", "Bash")).toEqual([]);
  });

  test("malformed matcher regex is treated as non-matching, not a crash", () => {
    const regs = [makeReg({ name: "a", event: "PreToolUse", matcher: "(unterminated" })];
    expect(() => getGuardsForEvent(regs, "PreToolUse", "Bash")).not.toThrow();
    expect(getGuardsForEvent(regs, "PreToolUse", "Bash")).toEqual([]);
  });

  test("multiple guards match the same event+tool independently", () => {
    const regs = [
      makeReg({ name: "a", event: "PreToolUse", matcher: "Bash" }),
      makeReg({ name: "b", event: "PreToolUse", matcher: "Bash|Edit" }),
    ];
    expect(getGuardsForEvent(regs, "PreToolUse", "Bash").map((r) => r.name)).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// findDuplicateRegistrations
// ---------------------------------------------------------------------------

/** The two guards declared as an intentional same-matcher pair (mt#3282). */
const PAIR_GUARD_A = "check-guessed-session-path";
const PAIR_GUARD_B = "block-secret-file-read";

describe("findDuplicateRegistrations", () => {
  test("two guards, same event, overlapping matcher token -> flagged", () => {
    const regs = [
      makeReg({ name: "a", event: "PreToolUse", matcher: "Edit|Write|NotebookEdit" }),
      makeReg({ name: "b", event: "PreToolUse", matcher: "Edit|mcp__minsky__session_edit_file" }),
    ];
    const dupes = findDuplicateRegistrations(regs);
    expect(dupes.length).toBe(1);
    expect(dupes[0]?.a).toBe("a");
    expect(dupes[0]?.b).toBe("b");
    expect(dupes[0]?.sharedTokens).toContain("Edit");
  });

  test("two guards, same event, disjoint matcher tokens -> not flagged", () => {
    const regs = [
      makeReg({ name: "a", event: "PreToolUse", matcher: "Bash" }),
      makeReg({ name: "b", event: "PreToolUse", matcher: "Edit|Write" }),
    ];
    expect(findDuplicateRegistrations(regs)).toEqual([]);
  });

  test("two guards, different events, same matcher -> not flagged", () => {
    const regs = [
      makeReg({ name: "a", event: "PreToolUse", matcher: "Bash" }),
      makeReg({ name: "b", event: "PostToolUse", matcher: "Bash" }),
    ];
    expect(findDuplicateRegistrations(regs)).toEqual([]);
  });

  test("two matcher-less registrations on a NON-tool-scoped event are NOT flagged (Phase 2a, mt#2652)", () => {
    // Matcher-less-at-the-same-event is the NORMAL shape for non-tool-scoped
    // events (UserPromptSubmit et al.) with multiple independent guards —
    // e.g. the six UserPromptSubmit guidance detectors migrated in Phase 2a.
    // Flagging every such pair would make the check impossible to satisfy.
    const regs = [
      makeReg({ name: "a", event: NON_TOOL_EVENT, matcher: undefined }),
      makeReg({ name: "b", event: NON_TOOL_EVENT, matcher: undefined }),
    ];
    expect(findDuplicateRegistrations(regs)).toEqual([]);
  });

  test("two matcher-less registrations on a TOOL-SCOPED event (PreToolUse) ARE flagged (R1 fix, mt#2652)", () => {
    // Unlike UserPromptSubmit, PreToolUse HAS a tool-name concept — two
    // matcher-less registrations there genuinely both match every tool
    // call, which is the real accidental-duplicate shape D7(2) exists to
    // catch. The non-tool-scoped exemption above must NOT apply here.
    const regs = [
      makeReg({ name: "a", event: "PreToolUse", matcher: undefined }),
      makeReg({ name: "b", event: "PreToolUse", matcher: undefined }),
    ];
    const dupes = findDuplicateRegistrations(regs);
    expect(dupes.length).toBe(1);
    expect(dupes[0]?.sharedTokens).toContain("<matches everything>");
  });

  test("two matcher-less registrations on PostToolUse (also tool-scoped) ARE flagged", () => {
    const regs = [
      makeReg({ name: "a", event: "PostToolUse", matcher: undefined }),
      makeReg({ name: "b", event: "PostToolUse", matcher: undefined }),
    ];
    const dupes = findDuplicateRegistrations(regs);
    expect(dupes.length).toBe(1);
  });

  test("a matcher-less registration still overlaps a registration WITH a matcher, on ANY event", () => {
    // The genuine-overlap-risk case remains flagged regardless of tool-scope:
    // a matcher-less guard fires on every tool, including whatever the
    // matchered guard names.
    const regs = [
      makeReg({ name: "a", event: "PreToolUse", matcher: undefined }),
      makeReg({ name: "b", event: "PreToolUse", matcher: "Bash" }),
    ];
    const dupes = findDuplicateRegistrations(regs);
    expect(dupes.length).toBe(1);
    expect(dupes[0]?.sharedTokens).toContain("<matches everything>");
  });

  test("a matcher-less registration overlaps a matchered registration on a non-tool-scoped event too", () => {
    const regs = [
      makeReg({ name: "a", event: NON_TOOL_EVENT, matcher: undefined }),
      makeReg({ name: "b", event: NON_TOOL_EVENT, matcher: "Bash" }),
    ];
    const dupes = findDuplicateRegistrations(regs);
    expect(dupes.length).toBe(1);
  });

  test("current GUARD_REGISTRY has no duplicate registrations (regression guard)", () => {
    expect(findDuplicateRegistrations(GUARD_REGISTRY)).toEqual([]);
  });

  // PR #2886 R1. A guard that reads `ctx.transcriptLines` without declaring
  // `needsTranscript` is not broken in any way its own unit tests can see: they
  // construct the context directly, so the module works perfectly and the
  // dispatcher hands it nothing. The result is a guard that is present, green
  // and inert — the `work-completion.mdc §Invocation path` shape, one layer in.
  //
  // Source-text keyed rather than behavioral, deliberately: the coupling is
  // between a module's code and its REGISTRATION, and no runtime exercise of
  // either half can observe the other. `command-source-scan.ts` sets the
  // precedent for asserting a registration property by reading source.
  test("every guard reading ctx.transcriptLines declares needsTranscript", () => {
    const hooksDir = new URL(".", import.meta.url).pathname;
    const violations: string[] = [];

    for (const reg of GUARD_REGISTRY) {
      // The module path is not on the registration (it is a lazy import
      // thunk), so match on the guard's own name — every guard module in this
      // directory is named for its registration.
      const modulePath = join(hooksDir, `${reg.name}.ts`);
      // eslint-disable-next-line custom/no-real-fs-in-tests -- the COMMITTED guard module is the artifact under test, exactly as the settings.json read below is. The assertion is that a module's source and its registration agree; an in-memory fixture would assert that a fixture agrees with itself, which is the one thing that cannot fail. Same justification as the import-site disable.
      if (!existsSync(modulePath)) continue;

      // eslint-disable-next-line custom/no-real-fs-in-tests -- see above: reading the real module source IS the check.
      const source = readFileSync(modulePath, "utf8");
      const readsTranscript = /\bctx\.transcriptLines\b|\btranscriptLines\b/.test(source);
      if (readsTranscript && !reg.needsTranscript) {
        violations.push(
          `${reg.name} reads transcriptLines but its registration omits needsTranscript — ` +
            `the dispatcher will never populate it and the guard is inert`
        );
      }
    }

    expect(violations).toEqual([]);
  });

  // mt#3282: two tool-scoped guards may intentionally share a matcher — the
  // dispatcher runs every match, first-deny-wins. The exemption is a declared
  // list, so it must NOT degrade into "tool-scoped overlaps are always fine."
  test("a DECLARED intentional pair is exempt", () => {
    const regs = [
      makeReg({ name: PAIR_GUARD_A, event: "PreToolUse", matcher: "Bash" }),
      makeReg({ name: PAIR_GUARD_B, event: "PreToolUse", matcher: "Bash" }),
    ];
    expect(findDuplicateRegistrations(regs)).toEqual([]);
  });

  test("an UNDECLARED overlap on the same event+matcher is still flagged", () => {
    const regs = [
      makeReg({ name: "some-guard", event: "PreToolUse", matcher: "Bash" }),
      makeReg({ name: "another-guard", event: "PreToolUse", matcher: "Bash" }),
    ];
    const dupes = findDuplicateRegistrations(regs);
    expect(dupes.length).toBe(1);
    expect(dupes[0]?.sharedTokens).toContain("Bash");
  });

  test("isIntentionalPair is order-insensitive", () => {
    expect(isIntentionalPair(PAIR_GUARD_A, PAIR_GUARD_B)).toBe(true);
    expect(isIntentionalPair(PAIR_GUARD_B, PAIR_GUARD_A)).toBe(true);
    expect(isIntentionalPair(PAIR_GUARD_B, "unrelated-guard")).toBe(false);
  });

  test("every declared pair names guards that actually exist in the registry", () => {
    // A stale entry would silently exempt a name that no longer registers,
    // re-opening the hole the declaration was meant to bound.
    const names = new Set(GUARD_REGISTRY.map((r) => r.name));
    for (const [a, b] of INTENTIONAL_MATCHER_PAIRS) {
      expect(names.has(a)).toBe(true);
      expect(names.has(b)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// NON_TOOL_SCOPED_EVENTS
// ---------------------------------------------------------------------------

describe("NON_TOOL_SCOPED_EVENTS", () => {
  test("contains exactly the five non-tool-scoped lifecycle events", () => {
    const expected: LifecycleEvent[] = [
      "SessionEnd",
      "SessionStart",
      "Stop",
      "SubagentStop",
      NON_TOOL_EVENT,
    ];
    expect([...NON_TOOL_SCOPED_EVENTS].sort()).toEqual(expected.sort());
  });

  test("does NOT contain the two tool-scoped events", () => {
    expect(NON_TOOL_SCOPED_EVENTS.has("PreToolUse")).toBe(false);
    expect(NON_TOOL_SCOPED_EVENTS.has("PostToolUse")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GUARD_REGISTRY sanity
// ---------------------------------------------------------------------------

describe("GUARD_REGISTRY", () => {
  test("pilot guard (check-guessed-session-path) is registered on PreToolUse", () => {
    const pilot = GUARD_REGISTRY.find((r) => r.name === PAIR_GUARD_A);
    expect(pilot).toBeDefined();
    expect(pilot?.event).toBe("PreToolUse");
    expect(pilot?.denyCapable).toBe(true);
  });

  test("every registration's module() resolves to an object with a run function", async () => {
    for (const reg of GUARD_REGISTRY) {
      const mod = await reg.module();
      expect(typeof mod.run).toBe("function");
    }
  });

  test("Phase 2a UserPromptSubmit family (mt#2652) is registered, no duplicates, correct calibration wiring", () => {
    const expectedCalibrationLogs: Record<string, string | undefined> = {
      // mt#3519: this used to expect `undefined` — and that undeclared join is
      // exactly why `operator-instruction-trigger` could only ever be reported
      // as unmapped by the coverage-receipt check. The guard's log name matches
      // neither the guard nor the file, so nothing but a declaration can find it.
      "substrate-bypass-detector": "operator-instruction-trigger",
      "retrospective-trigger-scanner": "retrospective-trigger",
      "pre-narration-detector": "pre-narration",
      "causal-premise-detector": "causal-premise",
      "code-mechanism-assertion-detector": "code-mechanism-assertion",
      "ask-routing-deferral-detector": "ask-routing-deferral",
    };
    for (const [name, calibrationLog] of Object.entries(expectedCalibrationLogs)) {
      const reg = GUARD_REGISTRY.find((r) => r.name === name);
      expect(reg).toBeDefined();
      expect(reg?.event).toBe(NON_TOOL_EVENT);
      expect(reg?.matcher).toBeUndefined();
      expect(reg?.denyCapable).toBe(false);
      expect(reg?.needsTranscript).toBe(true);
      // Object.entries widens the value to `string | undefined` (mt#2900).
      expect(reg?.calibrationLog).toBe(calibrationLog as string);
    }
    // policy-coverage-detector is NOT part of this family — it is registered
    // on PreToolUse in .claude/settings.json (ground truth), not
    // UserPromptSubmit. See the mt#2652 spec's recorded discrepancy.
    expect(GUARD_REGISTRY.find((r) => r.name === "policy-coverage-detector")).toBeUndefined();
  });

  test("no registration declares an EMPTY calibrationLog list (PR #2543 R1)", () => {
    // The type is `string | [string, ...string[]]`, so `[]` should be
    // unrepresentable — but registrations are hand-authored and a cast or a
    // widened local can get past it. An empty list is truthy, so it would sail
    // through every `if (reg.calibrationLog)` and then write nothing: a guard
    // silently recording no calibration data, the failure class mt#3519 exists
    // to make visible. This is the runtime backstop for the type.
    for (const reg of GUARD_REGISTRY) {
      const decl = reg.calibrationLog as string | string[] | undefined;
      if (Array.isArray(decl)) {
        expect(decl.length, `${reg.name} declares an empty calibrationLog list`).toBeGreaterThan(0);
        for (const name of decl) expect(name.length).toBeGreaterThan(0);
      } else if (decl !== undefined) {
        expect(decl.length).toBeGreaterThan(0);
      }
    }
  });

  test("every registration carries a tuningOwnership class (mt#3518 — stamp at birth)", () => {
    // The field is TYPED optional so an unrated guard fails soft at runtime,
    // but authoring-time coverage is mandatory: a new guard must be classified
    // (invariant / preference / advisory) when it is registered, per mem#802
    // and the beyond-Minsky RFC's 2026-08-01 amendment. An entry failing here
    // means the author skipped the classification, not that the value is
    // optional.
    const unstamped = GUARD_REGISTRY.filter((r) => r.tuningOwnership === undefined).map(
      (r) => r.name
    );
    expect(unstamped).toEqual([]);
  });

  test("deny-capable guards are never preference-class (dismissal must not relax a deny gate)", () => {
    const denyButTunable = GUARD_REGISTRY.filter(
      (r) => r.denyCapable && r.tuningOwnership === "preference"
    ).map((r) => r.name);
    expect(denyButTunable).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // mt#3981 (thin-hooks RFC rev. 2, phase 1) — `effects` declarations
  // ---------------------------------------------------------------------------

  test("every registration declares at least one effect (SC1 — runtime backstop for the type)", () => {
    // `effects` is typed as a non-empty tuple, so an omission fails typecheck
    // (AT1). This is the same belt-and-suspenders pattern as the
    // `calibrationLog` empty-list test above: registrations are hand-authored,
    // so a widened local or a cast could still get past the type.
    const empty = GUARD_REGISTRY.filter((r) => (r.effects as unknown[]).length === 0).map(
      (r) => r.name
    );
    expect(empty).toEqual([]);
  });

  test("a denyCapable guard declares at least one validator effect", () => {
    // The reverse isn't required (a validator-shaped effect doesn't force
    // denyCapable — see the merge-gate family's standalone declarations,
    // which are enforcement but not GUARD_REGISTRY-denyCapable), but a guard
    // that CAN deny should say so somewhere in its effects.
    const missingValidator = GUARD_REGISTRY.filter(
      (r) => r.denyCapable && !r.effects.some((e) => e.verdictShape === "validator")
    ).map((r) => r.name);
    expect(missingValidator).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Registry <-> settings.json registration parity (mt#3823)
// ---------------------------------------------------------------------------

/**
 * A registry entry only runs if `.claude/settings.json` ALSO routes its event
 * (and, for a tool-scoped event, its matcher) to the dispatcher entrypoint.
 * Those are two hand-maintained sources with nothing comparing them, which is
 * how `require-duplicate-check-record` (mt#3673, deny-capable) and
 * `duplicate-signature-scan` (mt#3722) both shipped registered and never once
 * ran: the `mcp__minsky__tasks_create` matcher had no dispatcher entry, so the
 * dispatcher was never spawned for that tool and neither guard produced a
 * single fire-log record between shipping and 2026-08-10. Two calibration
 * passes looked straight at the resulting `[FLAGGED]` coverage receipt and
 * theorized about timeouts, because nothing could see the missing wiring.
 *
 * ADR-028's own Phase 7 retires this check by GENERATING the settings.json
 * `hooks` block from the registry; until then this is the mechanical stand-in.
 * mt#3675 separately owns deriving each entry's timeout VALUE from the
 * registry's per-event sum — this file asserts only presence plus the floor
 * below, which is a different invariant (see the timeout test's comment).
 */
const SETTINGS_PATH = join(import.meta.dir, "..", "..", ".claude", "settings.json");

/** Dispatcher entrypoint filename per lifecycle event. */
const DISPATCHER_BY_EVENT: Record<string, string> = {
  PreToolUse: "dispatch-pretooluse.ts",
  Stop: "dispatch-stop.ts",
  UserPromptSubmit: "dispatch-userpromptsubmit.ts",
};

interface SettingsHookEntry {
  command?: string;
  timeout?: number;
}
interface SettingsMatcherBlock {
  matcher?: string;
  hooks?: SettingsHookEntry[];
}

function readSettingsBlocks(event: string): SettingsMatcherBlock[] {
  // eslint-disable-next-line custom/no-real-fs-in-tests -- see the import-site justification: the committed settings.json IS the subject of this assertion.
  const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as {
    hooks?: Record<string, SettingsMatcherBlock[]>;
  };
  return raw.hooks?.[event] ?? [];
}

/** Human-readable routing label, used in every failure message here. */
function describeRouting(event: string, matcher?: string): string {
  return matcher === undefined ? event : `${event} :: ${matcher}`;
}

/**
 * Does a settings.json matcher string route `toolName`? Mirrors the dispatcher's
 * own rule (`getGuardsForEvent`: `new RegExp(matcher).test(toolName)`, unanchored,
 * malformed-regex treated as non-matching) plus Claude Code's documented match-all
 * forms — omitted, `""`, or `"*"` (which is not a valid regex on its own).
 */
const MATCH_ALL_MATCHERS = new Set(["", "*"]);
function matcherRoutesTool(matcher: string | undefined, toolName: string): boolean {
  if (matcher === undefined || MATCH_ALL_MATCHERS.has(matcher)) return true;
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    return false;
  }
}

/** The literal tool names an alternation-style registry matcher is authored to cover. */
function toolNamesCoveredBy(matcher: string): string[] {
  return matcher
    .split(/[|,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** A matcher member that is a plain tool name, per Claude Code's matcher grammar. */
const LITERAL_TOOL_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Blocks whose command list includes the dispatcher for `event`. A block may
 * carry several commands and an event may have several blocks with the same
 * matcher — Claude Code runs all matching hooks (docs: "All matching hooks run
 * in parallel"), so any block carrying the dispatcher satisfies the routing.
 */
function dispatcherBlocks(event: string): SettingsMatcherBlock[] {
  const entrypoint = DISPATCHER_BY_EVENT[event];
  if (!entrypoint) return [];
  return readSettingsBlocks(event).filter((b) =>
    (b.hooks ?? []).some((h) => (h.command ?? "").endsWith(entrypoint))
  );
}

describe("registry <-> .claude/settings.json parity (mt#3823)", () => {
  test("every event in the registry has a known dispatcher entrypoint", () => {
    // Guards the map above: a registration on a NEW lifecycle event would
    // otherwise find no entrypoint, return no blocks, and silently pass the
    // routing tests below rather than failing them.
    const unmapped = [...new Set(GUARD_REGISTRY.map((r) => r.event))]
      .filter((e) => DISPATCHER_BY_EVENT[e] === undefined)
      .sort();
    expect(unmapped).toEqual([]);
  });

  test("every registry matcher is an alternation of literal tool names", () => {
    // The routing test below decides coverage by expanding a registry matcher
    // into the tool names it is authored to cover. That expansion is only sound
    // for the alternation-of-literals grammar every registration uses today. A
    // future registration written as a genuine regex (`^Bash$`, a character
    // class, a quantifier) would expand into nonsense members that no settings
    // matcher routes — a spurious failure. Fail HERE instead, where the message
    // says which matcher outgrew the expansion, so the coverage check is
    // extended deliberately rather than silently believed.
    const nonLiteral = GUARD_REGISTRY.filter((r) => r.matcher !== undefined)
      .flatMap((r) =>
        toolNamesCoveredBy(r.matcher as string)
          .filter((member) => !LITERAL_TOOL_NAME.test(member))
          .map((member) => `${describeRouting(r.event, r.matcher)}: member "${member}"`)
      )
      .sort();
    expect([...new Set(nonLiteral)]).toEqual([]);
  });

  test("every tool the registry's matchers cover is routed to the dispatcher", () => {
    // COVERAGE, not string equality (PR #2754 R1). The question is whether the
    // dispatcher is spawned for the tools a registration matches — so a settings
    // matcher that reorders the alternation (`B|A` for `A|B`), groups it, or
    // covers a strict superset routes those tools and must pass. Only a settings
    // side that routes strictly LESS is a defect, and this still catches it:
    // with no block matching `mcp__minsky__tasks_create` at all, both of that
    // matcher's guards are unreachable, which is the bug this whole block exists
    // for.
    const unrouted = new Set<string>();
    for (const reg of GUARD_REGISTRY) {
      if (reg.matcher === undefined) continue;
      const blocks = dispatcherBlocks(reg.event);
      for (const toolName of toolNamesCoveredBy(reg.matcher)) {
        if (blocks.some((b) => matcherRoutesTool(b.matcher, toolName))) continue;
        // Named, not counted: the failure message has to say WHICH tool lost its
        // wiring, since the whole defect class is invisible from the guard's side.
        unrouted.add(`${reg.event} :: ${toolName}`);
      }
    }
    expect([...unrouted].sort()).toEqual([]);
  });

  test("every matcher-less event in the registry is routed to the dispatcher", () => {
    const events = [
      ...new Set(GUARD_REGISTRY.filter((r) => r.matcher === undefined).map((r) => r.event)),
    ].sort();
    const unrouted = events.filter((e) => dispatcherBlocks(e).length === 0);
    expect(unrouted).toEqual([]);
  });

  test("a dispatcher entry's timeout clears the largest guard budget it carries", () => {
    // A FLOOR, not the derived value — mt#3675 owns deriving the per-event SUM.
    // The floor exists because the registry's timeoutMs comments depend on the
    // guard's OWN deadline firing before the dispatcher is killed: a killed
    // dispatcher records nothing, so a sustained infra outage reads as a clean
    // pass (duplicate-signature-scan's registration says exactly this). An entry
    // below its largest guard's budget breaks that ordering silently, and every
    // other dispatcher entry in settings.json is 15s — well under this matcher's
    // 18s scan, so copying the common value would have been wrong here.
    const violations: string[] = [];
    for (const reg of GUARD_REGISTRY) {
      // Same coverage relation as the routing test above, not string equality
      // (PR #2754 R1 class scan): the entries that must clear this guard's
      // budget are the ones that actually spawn the dispatcher for its tools.
      const blocks = dispatcherBlocks(reg.event).filter(
        (b) =>
          reg.matcher === undefined ||
          toolNamesCoveredBy(reg.matcher).some((tool) => matcherRoutesTool(b.matcher, tool))
      );
      for (const block of blocks) {
        const entrypoint = DISPATCHER_BY_EVENT[reg.event] as string;
        for (const hook of block.hooks ?? []) {
          if (!(hook.command ?? "").endsWith(entrypoint)) continue;
          const entryBudgetMs = (hook.timeout ?? 0) * 1000;
          if (entryBudgetMs < reg.timeoutMs) {
            violations.push(
              `${describeRouting(reg.event, reg.matcher)}: entry timeout ${hook.timeout}s < ${reg.name}'s timeoutMs ${reg.timeoutMs}ms`
            );
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("a dispatcher entry's timeout equals the DERIVED sum of its routed guards' budgets (mt#3981, absorbing mt#3675 SC1)", () => {
    // The floor test above only checks against the LARGEST single guard
    // budget on the block — it does not catch the Stop-family drift class
    // (mt#3536/mt#3593/mem#746: guard budget grows, the entry timeout does
    // not, and a killed dispatcher silently loses every remaining guard's
    // verdict). This test asserts EQUALITY against `deriveDispatchTimeoutMs`
    // (SUM of the block's routed guards + `DISPATCH_TIMEOUT_MARGIN_MS`), the
    // same routing relation ("clears the largest guard budget" above) that
    // decides which guards a given matcher block actually carries.
    const violations: string[] = [];
    for (const event of Object.keys(DISPATCHER_BY_EVENT)) {
      for (const block of dispatcherBlocks(event)) {
        const routedGuards = GUARD_REGISTRY.filter(
          (reg) =>
            reg.event === event &&
            (reg.matcher === undefined ||
              toolNamesCoveredBy(reg.matcher).some((tool) =>
                matcherRoutesTool(block.matcher, tool)
              ))
        );
        const derivedMs = deriveDispatchTimeoutMs(routedGuards.map((r) => r.timeoutMs));
        const entrypoint = DISPATCHER_BY_EVENT[event] as string;
        for (const hook of block.hooks ?? []) {
          if (!(hook.command ?? "").endsWith(entrypoint)) continue;
          const declaredMs = (hook.timeout ?? 0) * 1000;
          if (declaredMs !== derivedMs) {
            violations.push(
              `${describeRouting(event, block.matcher)}: declared ${hook.timeout}s != derived ${
                derivedMs / 1000
              }s (sum of [${routedGuards.map((r) => `${r.name}:${r.timeoutMs}ms`).join(", ")}] + ${
                DISPATCH_TIMEOUT_MARGIN_MS / 1000
              }s margin)`
            );
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Family-composition order invariants (mt#4115)
// ---------------------------------------------------------------------------
//
// mt#4115 moved every registry entry into a per-family module and left
// `GUARD_REGISTRY` a composition of spreads. That move's correctness argument is
// entirely about ORDER — `getGuardsForEvent` filters by event then matcher, and
// the dispatcher runs the FILTERED list with first-deny-wins — and it was
// initially carried only by comments in `registry.ts` plus a diff of
// `scripts/dump-guard-registry.ts` output taken by hand at review time. PR #3027
// R1 pointed out that nothing would FAIL if a later edit broke it.
//
// These tests are that failure. They encode the argument itself, not a snapshot:
// each one is self-maintaining, so adding a guard to a family updates both sides
// at once and none of them needs touching.
//
// **What they do NOT cover, stated so nobody reads more into a green run.**
// Being self-maintaining is exactly why they cannot see a guard REORDERED WITHIN
// its own family module: that edit moves the family array and `GUARD_REGISTRY`
// together, so every comparison below still balances. The uncovered consequence
// is narrow — for two guards that would both deny the same tool call,
// first-deny-wins decides which denial message the operator sees — and it is
// bounded to `COMMAND_STRING_GUARDS`, the only family with more than one
// `denyCapable` member. `scripts/dump-guard-registry.ts` is what catches that:
// it renders the per-(event, tool) dispatch lists from the real
// `getGuardsForEvent`, so diffing its output across a change sees intra-family
// order. Run it before and after any deliberate registry reorganization.

describe("GUARD_REGISTRY family composition (mt#4115)", () => {
  const FAMILIES: ReadonlyArray<readonly [string, readonly GuardRegistration[]]> = [
    ["TASK_CREATE_GUARDS", TASK_CREATE_GUARDS],
    ["PR_CREATE_GUARDS", PR_CREATE_GUARDS],
    ["COMMAND_STRING_GUARDS", COMMAND_STRING_GUARDS],
    ["DELEGATION_GUARDS", DELEGATION_GUARDS],
    ["PROMPT_INJECTION_GUARDS", PROMPT_INJECTION_GUARDS],
    ["PROMPT_SCAN_GUARDS", PROMPT_SCAN_GUARDS],
    ["TURN_END_GUARDS", TURN_END_GUARDS],
  ];

  /**
   * The one entry deliberately left inline in `registry.ts`, because its
   * position IS its contract — see
   * docs/architecture/hooks/calibration-review-cadence-detector.md.
   */
  const INLINE_LAST_ENTRY = "calibration-review-cadence-detector";

  const names = (regs: readonly GuardRegistration[]): string[] => regs.map((r) => r.name);

  test("every family spreads into GUARD_REGISTRY as one contiguous run, in its own order", () => {
    const registryNames = names(GUARD_REGISTRY);
    for (const [label, family] of FAMILIES) {
      const positions = family.map((g) => registryNames.indexOf(g.name));
      expect(`${label}: ${positions.filter((p) => p < 0).length} members missing`).toBe(
        `${label}: 0 members missing`
      );
      // A single spread necessarily yields consecutive indices. Anything else
      // means the family was split, reordered, or had an entry inlined into the
      // middle of it — each of which can change a co-matching dispatch order.
      const consecutive = positions.every(
        (p, i) => i === 0 || p === (positions[i - 1] as number) + 1
      );
      expect(`${label} contiguous: ${consecutive}`).toBe(`${label} contiguous: true`);
    }
  });

  test("the two UserPromptSubmit families are adjacent, and the inline entry is last in that event", () => {
    // This event's guards are all matcher-less, so every one of them co-fires on
    // every prompt: the whole sequence is a single co-matching set. Asserting the
    // exact sequence is therefore asserting the dispatch order directly.
    expect(names(GUARD_REGISTRY.filter((r) => r.event === "UserPromptSubmit"))).toEqual([
      ...names(PROMPT_INJECTION_GUARDS),
      ...names(PROMPT_SCAN_GUARDS),
      INLINE_LAST_ENTRY,
    ]);
  });

  test("calibration-review-cadence-detector is the LAST entry in the array", () => {
    expect(GUARD_REGISTRY.at(-1)?.name).toBe(INLINE_LAST_ENTRY);
  });

  test("no entry is inlined into registry.ts outside the one documented exception", () => {
    // The split is only worth having if entries stay in family modules; an entry
    // written back into `registry.ts` would rebuild the max-lines pressure
    // mt#4115 removed, one guard at a time.
    const filed = new Set(FAMILIES.flatMap(([, family]) => names(family)));
    const strays = names(GUARD_REGISTRY).filter((n) => !filed.has(n) && n !== INLINE_LAST_ENTRY);
    expect(strays).toEqual([]);
  });

  test("PreToolUse families share no matcher token, so their order relative to each other is inert", () => {
    // This is the premise that licenses arranging families freely. It held when
    // mt#4115 measured it; a guard added to the "wrong" family could break it
    // silently, at which point cross-family order WOULD be load-bearing and the
    // contiguity test above would no longer be sufficient on its own.
    const tokensOf = (family: readonly GuardRegistration[]): Set<string> =>
      new Set(
        family
          .filter((g) => g.event === "PreToolUse")
          .flatMap((g) => (g.matcher ?? "").split("|").filter(Boolean))
      );

    const preToolUse = FAMILIES.filter(([, f]) => f.some((g) => g.event === "PreToolUse"));
    const overlaps: string[] = [];
    for (let i = 0; i < preToolUse.length; i++) {
      for (let j = i + 1; j < preToolUse.length; j++) {
        const [labelA, famA] = preToolUse[i] as readonly [string, readonly GuardRegistration[]];
        const [labelB, famB] = preToolUse[j] as readonly [string, readonly GuardRegistration[]];
        const tokensB = tokensOf(famB);
        const shared = [...tokensOf(famA)].filter((t) => tokensB.has(t));
        if (shared.length) overlaps.push(`${labelA} x ${labelB}: ${shared.join(",")}`);
      }
    }
    expect(overlaps).toEqual([]);
  });
});
