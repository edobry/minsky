// Tests for the code-mechanism-assertion-detector hook (mt#2486).
//
// Pure-function coverage: detectCodeMechanismAssertion (claim + corpus),
// buildVerificationCorpus (tool inputs + tool_result content), and
// elideBlocksAndQuotes. The canonical case is R9 (PR #1694): a maxBuffer/
// executeCommand behavioral claim made without reading exec.ts.
//
// main()/CLI-path E2E coverage (mt#3002 R1, mirrors pre-narration-detector.
// test.ts): the hook reads real transcript files via fs.readFileSync and the
// E2E tests below must write real transcript JSONL files so Bun.spawn can
// read them.

/* eslint-disable custom/no-real-fs-in-tests -- see file-header note above */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectCodeMechanismAssertion,
  buildVerificationCorpus,
  elideBlocksAndQuotes,
  buildRelayCorpus,
  detectRelayContext,
  RELAY_PREAMBLE_PATTERNS,
  computeSuppressionReasons,
  OVERRIDE_ENV_VAR,
  INJECTION_ENABLED,
  run,
} from "./code-mechanism-assertion-detector";
import type { TranscriptLine } from "./transcript";
import type { ClaudeHookInput } from "./types";
import type { DispatchContext } from "./registry";

// A realistic slice of exec.ts source — what a Read of the file would return.
const EXEC_TS_SOURCE = `export async function executeCommand(command, options = {}) {
  const execOptions = { encoding: "utf8", maxBuffer: 1024 * 1024 * 10, killSignal: "SIGTERM" };
  return promisifiedExec(command, execOptions);
}`;

describe("detectCodeMechanismAssertion", () => {
  test("R9 canonical: maxBuffer/executeCommand behavioral claim with NO same-turn read → fires", () => {
    const text =
      "Diagnosing the pre-commit failure: the 1MB default `maxBuffer` is at its limit, " +
      "and `executeCommand` clamps it — so I shipped a 64MB override.";
    const result = detectCodeMechanismAssertion(text, /* corpus */ "");
    expect(result.matched).toBe(true);
    const syms = result.claims.map((c) => c.symbol);
    expect(syms).toContain("maxBuffer");
    expect(syms).toContain("executeCommand");
  });

  test("same-turn Read of the symbol's file (source in tool_result corpus) → does NOT fire", () => {
    const text = "`executeCommand` clamps `maxBuffer` to 10MB.";
    // The file source landed in a same-turn tool_result; both symbols appear in it.
    const result = detectCodeMechanismAssertion(text, EXEC_TS_SOURCE);
    expect(result.matched).toBe(false);
    expect(result.hadSameTurnRead).toBe(true);
  });

  test("backing via read-class tool INPUT (grep pattern names the symbol) → does NOT fire", () => {
    const text = "The `parseBranchProtectionResponse` helper returns null on a parse error.";
    const result = detectCodeMechanismAssertion(text, "grep -n parseBranchProtectionResponse src/");
    expect(result.matched).toBe(false);
  });

  test("generic prose with no named symbol near a predicate → does NOT fire", () => {
    const text = "The build passed and all 138 tests are green; nothing else to report.";
    expect(detectCodeMechanismAssertion(text, "").matched).toBe(false);
  });

  test("symbol+predicate only inside a fenced code block → does NOT fire", () => {
    const text =
      "Here is the relevant code:\n\n```ts\nexecuteCommand clamps maxBuffer to 10MB\n```\n\nThat is all.";
    expect(detectCodeMechanismAssertion(text, "").matched).toBe(false);
  });

  test("symbol+predicate inside a blockquote (quoted, not asserted) → does NOT fire", () => {
    const text = "> executeCommand clamps maxBuffer to 10MB\n\nNoted from the doc.";
    expect(detectCodeMechanismAssertion(text, "").matched).toBe(false);
  });

  test("empty assistant text → does NOT fire", () => {
    expect(detectCodeMechanismAssertion("", "").matched).toBe(false);
  });

  test("a partially-backed turn still fires on the UNread symbol", () => {
    // executeCommand was read (in corpus); maxBuffer's behavior is claimed but
    // the symbol is NOT in the corpus → the unread symbol still fires.
    const text = "`executeCommand` is fine, but `unreadHelper` defaults to retrying forever.";
    const result = detectCodeMechanismAssertion(text, "export function executeCommand() {}");
    expect(result.matched).toBe(true);
    expect(result.claims.map((c) => c.symbol)).toContain("unreadHelper");
  });

  test("backticked file path does NOT yield its extension as a claim symbol (R1)", () => {
    // `exec.ts` must not produce "ts"/"json" as a symbol (the removed
    // last-segment fallback). The full token may appear; the extension must not.
    const text = "The `exec.ts` module returns a config object.";
    const result = detectCodeMechanismAssertion(text, "");
    const syms = result.claims.map((c) => c.symbol);
    expect(syms).not.toContain("ts");
    expect(syms).not.toContain("json");
  });
});

describe("mt#2673 — truncated-substring extraction + backed-claim accounting", () => {
  const SESSION_PR_DRIVE = "session_pr_drive";

  test("AT2: window boundary cutting through the identifier yields the full symbol, no truncated tails", () => {
    // Position the identifier so the predicate's ±100-char proximity
    // window starts MID-IDENTIFIER — the 2026-07-07 calibration records'
    // "ion_pr_drive"/"on_pr_drive" bug shape.
    const sym = SESSION_PR_DRIVE;
    const text = `intro text here. ${sym} ${"z".repeat(90)} returns null when the input is missing.`;
    const anchor = text.indexOf("returns");
    // Sanity: the window cut (anchor - 100) lands inside the symbol.
    const symStart = text.indexOf(sym);
    expect(anchor - 100).toBeGreaterThan(symStart);
    expect(anchor - 100).toBeLessThan(symStart + sym.length);

    const result = detectCodeMechanismAssertion(text, "");
    const syms = result.claims.map((c) => c.symbol);
    expect(syms).toContain(sym);
    for (const s of syms) {
      expect(s === sym || !sym.endsWith(s)).toBe(true);
    }
    expect(syms).not.toContain("ion_pr_drive");
    expect(syms).not.toContain("on_pr_drive");
  });

  test("AT2: one identifier mention yields exactly one claim for that identifier per predicate", () => {
    const text = "The `session_pr_drive` helper returns null when the PR is already merged.";
    const result = detectCodeMechanismAssertion(text, "");
    const driveClaims = result.claims.filter((c) => c.symbol.includes("pr_drive"));
    expect(driveClaims.length).toBe(1);
    expect(driveClaims[0]?.symbol).toBe(SESSION_PR_DRIVE);
  });

  test("AT1: symbol present in the verification corpus → no claim logged, backedClaimCount >= 1", () => {
    const text = "`session_pr_drive` returns null when the PR is already merged.";
    const result = detectCodeMechanismAssertion(
      text,
      "export async function session_pr_drive() { /* read this turn */ }"
    );
    expect(result.claims.map((c) => c.symbol)).not.toContain(SESSION_PR_DRIVE);
    expect(result.backedClaimCount).toBeGreaterThanOrEqual(1);
    expect(result.hadSameTurnRead).toBe(true);
  });

  test("AT1: symbol NOT in the corpus → fires with the claim and backedClaimCount 0", () => {
    const text = "`session_pr_drive` returns null when the PR is already merged.";
    const result = detectCodeMechanismAssertion(text, "unrelated corpus content");
    expect(result.matched).toBe(true);
    expect(result.claims.map((c) => c.symbol)).toContain(SESSION_PR_DRIVE);
    expect(result.backedClaimCount).toBe(0);
    expect(result.hadSameTurnRead).toBe(false);
  });

  test("proper-substring dedup does not eliminate equal-length case variants", () => {
    // Both `maxBuffer` and `MaxBuffer` near a predicate: neither is a PROPER
    // substring of the other, so neither is dropped by the dedup filter.
    const text = "`maxBuffer` and `MaxBuffer` default to 1MB in this module.";
    const result = detectCodeMechanismAssertion(text, "");
    const syms = result.claims.map((c) => c.symbol);
    expect(syms).toContain("maxBuffer");
    expect(syms).toContain("MaxBuffer");
  });

  test("R1: separately-mentioned substring symbols are BOTH kept (`drive` alongside `session_pr_drive`)", () => {
    // PR #1835 R1 blocking finding: dedup must target truncation residues
    // (same-class strict range containment), not distinct mentions that
    // happen to be substrings.
    const text = "`drive` and `session_pr_drive` return null when the target is missing.";
    const result = detectCodeMechanismAssertion(text, "");
    const syms = result.claims.map((c) => c.symbol);
    expect(syms).toContain("drive");
    expect(syms).toContain(SESSION_PR_DRIVE);
  });

  test("R1: camel sub-identifier inside a backticked dotted token is kept (different class)", () => {
    // Documented behavior (symbolsNear header): `maxBuffer` inside
    // `cfg.maxBuffer` is captured independently — cross-class containment
    // must not dedup it away.
    const text = "The `cfg.maxBuffer` value defaults to 1MB here.";
    const result = detectCodeMechanismAssertion(text, "");
    const syms = result.claims.map((c) => c.symbol);
    expect(syms).toContain("maxBuffer");
    expect(syms).toContain("cfg.maxBuffer");
  });
});

// Shared genuine-claim fixture (tasks_create::guard-style, per the mt#3002
// spec's AT3/AT4) — reused across the pure-function and E2E CLI tests below.
const GENUINE_UNBACKED_CLAIM_TEXT = "`tasks_create` guards against duplicate task creation.";

describe("mt#3002 — file-name and hex-id symbol-class exclusions", () => {
  test("AT1: 2026-07-21T08:13-shaped fixture (hook-files.mdc + override/trim verbs) -> no claim extracted", () => {
    const text =
      "See `hook-files.mdc` for how the override behaves; the same section says it also " +
      "trims trailing whitespace, per `hook-files.mdc`.";
    const result = detectCodeMechanismAssertion(text, "");
    expect(result.matched).toBe(false);
    expect(result.claims).toEqual([]);
  });

  test("AT1b: 2026-07-20T20:31-shaped fixture (src/cockpit/CLAUDE.md + Guard verb) -> no claim extracted", () => {
    const text = "Guard behavior for this page is documented in `src/cockpit/CLAUDE.md`.";
    const result = detectCodeMechanismAssertion(text, "");
    expect(result.matched).toBe(false);
    expect(result.claims).toEqual([]);
  });

  test("AT2: 2026-07-21T00:26-shaped fixture (bare hex-id token near a mechanism verb) -> no claim extracted", () => {
    const text = "The commit `a30378971` guards against the regression.";
    const result = detectCodeMechanismAssertion(text, "");
    expect(result.matched).toBe(false);
    expect(result.claims).toEqual([]);
  });

  test("doc/config extensions beyond .md/.mdc are also excluded (.json, .yml, .yaml, .txt)", () => {
    const text =
      "The `config.json` overrides the defaults, `settings.yaml` trims trailing entries, " +
      "`build.yml` guards the pipeline, and `notes.txt` requires review.";
    const result = detectCodeMechanismAssertion(text, "");
    expect(result.matched).toBe(false);
    expect(result.claims).toEqual([]);
  });

  test("AT3: genuine unbacked claim (tasks_create::guard-style) still extracted, and injected (INJECTION_ENABLED=true)", () => {
    const text = GENUINE_UNBACKED_CLAIM_TEXT;
    const result = detectCodeMechanismAssertion(text, "");
    expect(result.matched).toBe(true);
    expect(result.claims.map((c) => c.symbol)).toContain("tasks_create");

    const transcriptLines = [makeRunUserLine(), makeRunAssistantLine(text), makeRunUserLine()];
    const outcome = run(RUN_HOOK_INPUT, makeCtx(transcriptLines), ALWAYS_INJECT_DEPS);
    expect(INJECTION_ENABLED).toBe(true);
    expect(outcome?.additionalContext).toBeDefined();
    expect(outcome?.additionalContext).toContain("tasks_create");
  });

  test("AT4: same fixture WITH a same-turn read of the symbol -> no fire (backed-claim exclusion intact)", () => {
    const text = GENUINE_UNBACKED_CLAIM_TEXT;
    const corpus = "export async function tasks_create() { /* read this turn */ }";
    const result = detectCodeMechanismAssertion(text, corpus);
    expect(result.matched).toBe(false);
    expect(result.hadSameTurnRead).toBe(true);

    const transcriptLines = [
      makeRunUserLine(),
      makeRunAssistantLine(text),
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: corpus }],
        },
      } as TranscriptLine,
      makeRunUserLine(),
    ];
    const outcome = run(RUN_HOOK_INPUT, makeCtx(transcriptLines), ALWAYS_INJECT_DEPS);
    expect(outcome).toBeNull();
  });

  test("SC2 regression: session_pr_merge (snake_case) still extracts as a genuine claim", () => {
    const text = "`session_pr_merge` requires a clean working tree before it proceeds.";
    const result = detectCodeMechanismAssertion(text, "");
    expect(result.matched).toBe(true);
    expect(result.claims.map((c) => c.symbol)).toContain("session_pr_merge");
  });

  test("SC2 regression: execWithPath (camelCase) still extracts as a genuine claim", () => {
    const text = "`execWithPath` guards against a missing PATH entry.";
    const result = detectCodeMechanismAssertion(text, "");
    expect(result.matched).toBe(true);
    expect(result.claims.map((c) => c.symbol)).toContain("execWithPath");
  });

  test("SC2 regression: MINSKY_SKIP_SIZE_BUDGET-style env var (2026-07-21T08:13/T08:42 records) still extracts", () => {
    const text = "`MINSKY_SKIP_SIZE_BUDGET` overrides the size gate for this run.";
    const result = detectCodeMechanismAssertion(text, "");
    expect(result.matched).toBe(true);
    expect(result.claims.map((c) => c.symbol)).toContain("MINSKY_SKIP_SIZE_BUDGET");
  });

  test("hex-id exclusion does not reject genuine hex-adjacent identifiers with case-mixing", () => {
    // `deadBeefCache` mixes case and is not entirely hex digits -> not excluded.
    const text = "`deadBeefCache` defaults to an empty map.";
    const result = detectCodeMechanismAssertion(text, "");
    expect(result.matched).toBe(true);
    expect(result.claims.map((c) => c.symbol)).toContain("deadBeefCache");
  });

  test("hex-id exclusion is length-bounded (7 chars, below the 8-40 range) -> a short hex-shaped token still extracts", () => {
    // Below the mt#3002 regex's 8-char floor; kept deliberately loose below the
    // floor since short hex-shaped tokens are ambiguous with real short symbols.
    const text = "`a303789` guards against the regression.";
    const result = detectCodeMechanismAssertion(text, "");
    expect(result.matched).toBe(true);
    expect(result.claims.map((c) => c.symbol)).toContain("a303789");
  });
});

describe("mt#3042 — SQL/DDL keyword symbol-class exclusion", () => {
  test("uppercase DDL keywords in a migration discussion do NOT count as symbols (16:12Z record shape)", () => {
    // The 2026-07-21T16:12Z calibration record: prose about a role-permission
    // migration extracted `ALTER`/`DROP`/`CREATE` as backticked "symbols" near
    // the `drops?` predicate. The uppercase-exact exclusion kills the pairs.
    const text =
      "The migration runs `ALTER` then `DROP` on the old index and `CREATE` on the new one — " +
      "it drops the stale grants for the role.";
    const result = detectCodeMechanismAssertion(text, "");
    const syms = result.claims.map((c) => c.symbol);
    expect(syms).not.toContain("ALTER");
    expect(syms).not.toContain("DROP");
    expect(syms).not.toContain("CREATE");
    // The whole record shape must not fire at all — no residual token in the
    // fixture survives symbol-plausibility, so zero claims are logged.
    expect(result.matched).toBe(false);
    expect(result.claims).toHaveLength(0);
  });

  test("lowercase same-spelled identifiers are still valid symbols", () => {
    // `create` as a real method name: the exclusion is UPPERCASE-exact, so a
    // genuine lowercase identifier near a predicate still fires.
    const camel = detectCodeMechanismAssertion(
      "`repoCreate` defaults to inserting a detected-state row.",
      ""
    );
    expect(camel.matched).toBe(true);
    expect(camel.claims.map((c) => c.symbol)).toContain("repoCreate");
    // Bare backticked lowercase `create` (exactly the excluded keyword's
    // spelling, different case) is likewise still a valid symbol.
    const bare = detectCodeMechanismAssertion(
      "`create` defaults to inserting a detected-state row.",
      ""
    );
    expect(bare.matched).toBe(true);
    expect(bare.claims.map((c) => c.symbol)).toContain("create");
  });

  test("`postgres` is stoplisted as a prose/product name", () => {
    const text = "`postgres` drops the connection when the pool is exhausted.";
    const result = detectCodeMechanismAssertion(text, "");
    expect(result.claims.map((c) => c.symbol)).not.toContain("postgres");
    expect(result.matched).toBe(false);
  });

  test("regression (ask#5343 tune-1 correction): a backed sibling does NOT suppress an unbacked claim — it fires with hadSameTurnRead=true", () => {
    // hadSameTurnRead is a TURN-level aggregate (mt#2673): logged claims are
    // definitionally unbacked; a record with hadSameTurnRead=true is NOT a
    // false positive. The ask#5343 review's proposed record-level suppression
    // would have silenced exactly this target class — kept unimplemented.
    const text = "`readHelper` is fine; `unreadEnvGuard` overrides the default when set.";
    const result = detectCodeMechanismAssertion(text, "export function readHelper() {}");
    expect(result.matched).toBe(true);
    expect(result.hadSameTurnRead).toBe(true);
    expect(result.claims.map((c) => c.symbol)).toContain("unreadEnvGuard");
  });
});

describe("mt#3050 — R13 sourcing/provenance predicates (capability/affordance claims)", () => {
  // The R13 incident (mt#3050 spec): "the router suggestion is sourced from
  // the existing `tasks_route` / `tasks_estimate` seam" — a capability claim
  // about a named tool/seam, not a code-identifier BEHAVIOR claim. Symbol
  // extraction already handled snake_case tool ids; the gap was that none of
  // the 15 pre-mt#3050 PREDICATE_PATTERNS entries were sourcing/provenance
  // verbs.
  const R13_SENTENCE =
    "the router suggestion is sourced from the existing `tasks_route` / `tasks_estimate` seam.";

  test("AT(a): the literal R13 assertion fires, on both named tool ids", () => {
    const result = detectCodeMechanismAssertion(R13_SENTENCE, "");
    expect(result.matched).toBe(true);
    const syms = result.claims.map((c) => c.symbol);
    expect(syms).toContain("tasks_route");
    expect(syms).toContain("tasks_estimate");
  });

  test("AT(b): a same-turn read of the named seam (control) suppresses the claim", () => {
    // Same sentence, but this turn's verification corpus contains the source
    // of task-routing-service.ts (as if the file had been Read this turn) —
    // the same-turn-read control per the mt#3050 acceptance criteria.
    const corpus =
      "export interface AvailableTask {} export interface RouteStep {} " +
      "export interface TaskRoute {} function tasks_route() {} function tasks_estimate() {}";
    const result = detectCodeMechanismAssertion(R13_SENTENCE, corpus);
    expect(result.matched).toBe(false);
    expect(result.hadSameTurnRead).toBe(true);
  });

  test("AT(c): existing behavior-verb patterns still fire unaffected (no regression from the new predicates)", () => {
    // The R9 canonical case, re-run after the PREDICATE_PATTERNS widening —
    // confirms the pre-existing 15 behavior-verb patterns are untouched.
    const text =
      "Diagnosing the pre-commit failure: the 1MB default `maxBuffer` is at its limit, " +
      "and `executeCommand` clamps it — so I shipped a 64MB override.";
    const result = detectCodeMechanismAssertion(text, "");
    expect(result.matched).toBe(true);
    const syms = result.claims.map((c) => c.symbol);
    expect(syms).toContain("maxBuffer");
    expect(syms).toContain("executeCommand");
  });

  test("'comes from' fires on an unread symbol", () => {
    const result = detectCodeMechanismAssertion(
      "That default comes from `legacyConfigLoader` under the hood.",
      ""
    );
    expect(result.matched).toBe(true);
    expect(result.claims.map((c) => c.symbol)).toContain("legacyConfigLoader");
  });

  test("'supplied by' / 'supplies' fire on an unread symbol", () => {
    const suppliedBy = detectCodeMechanismAssertion(
      "The retry count is supplied by `retryPolicyResolver`.",
      ""
    );
    expect(suppliedBy.matched).toBe(true);
    expect(suppliedBy.claims.map((c) => c.symbol)).toContain("retryPolicyResolver");

    const supplies = detectCodeMechanismAssertion(
      "`retryPolicyResolver` supplies the retry count for this path.",
      ""
    );
    expect(supplies.matched).toBe(true);
    expect(supplies.claims.map((c) => c.symbol)).toContain("retryPolicyResolver");
  });

  test("'backed by' fires on an unread symbol", () => {
    const result = detectCodeMechanismAssertion(
      "This estimate is backed by `taskEffortModel` under the hood.",
      ""
    );
    expect(result.matched).toBe(true);
    expect(result.claims.map((c) => c.symbol)).toContain("taskEffortModel");
  });

  test("'reads from' / 'pulls from' / 'derives from' fire on an unread symbol", () => {
    const readsFrom = detectCodeMechanismAssertion(
      "The scheduler reads from `taskQueueStore` for its next batch.",
      ""
    );
    expect(readsFrom.matched).toBe(true);
    expect(readsFrom.claims.map((c) => c.symbol)).toContain("taskQueueStore");

    const pullsFrom = detectCodeMechanismAssertion(
      "The widget pulls from `attentionCostCache` to render the tile.",
      ""
    );
    expect(pullsFrom.matched).toBe(true);
    expect(pullsFrom.claims.map((c) => c.symbol)).toContain("attentionCostCache");

    const derivesFrom = detectCodeMechanismAssertion(
      "The priority score derives from `taskRoutingService` output.",
      ""
    );
    expect(derivesFrom.matched).toBe(true);
    expect(derivesFrom.claims.map((c) => c.symbol)).toContain("taskRoutingService");
  });

  test("bare 'provides'/'exposes' are deliberately NOT added — no claim fires on those verbs alone", () => {
    // Spec's Revised Fix section: bare provides/exposes are deferred pending
    // calibration evidence (high prose-collision risk with INJECTION_ENABLED
    // = true). A sentence using only these verbs near a symbol must not
    // produce a claim keyed on a provides/exposes predicate match.
    const text = "This PR provides a new `widgetRenderer` helper and exposes `configLoader`.";
    const result = detectCodeMechanismAssertion(text, "");
    // Neither bare verb is itself a PREDICATE_PATTERNS entry, so no claim is
    // produced from this sentence in isolation (no other predicate present).
    expect(result.matched).toBe(false);
  });
});

describe("mt#3113 leg 2 — symbol-plausibility extension (generic English/tech words + bare dir refs)", () => {
  test("2026-07-23 calibration fixture: `since`/`description`/`macOS`/`CommonJS`/`target/` extract NO claims", () => {
    const text =
      "The `since` parameter defaults to null, `description` requires a non-empty " +
      "string, `macOS` overrides the resolver here, `CommonJS` guards against duplicate " +
      "module registration, and `target/` guards against a stale artifact.";
    const result = detectCodeMechanismAssertion(text, "");
    const syms = result.claims.map((c) => c.symbol);
    expect(syms).not.toContain("since");
    expect(syms).not.toContain("description");
    expect(syms).not.toContain("macOS");
    expect(syms).not.toContain("CommonJS");
    expect(syms).not.toContain("target/");
    expect(result.matched).toBe(false);
    expect(result.claims).toEqual([]);
  });

  test("bare directory reference (`target/`) is excluded even in isolation", () => {
    const text = "`target/` guards against a stale build artifact.";
    const result = detectCodeMechanismAssertion(text, "");
    expect(result.matched).toBe(false);
    expect(result.claims).toEqual([]);
  });

  test("multi-segment paths and code-extension paths remain plausible (path-like shape unaffected)", () => {
    const text = "`src/exec.ts` guards against a missing buffer config.";
    const result = detectCodeMechanismAssertion(text, "");
    expect(result.matched).toBe(true);
    expect(result.claims.map((c) => c.symbol)).toContain("src/exec.ts");
  });

  test("AT (negative control): genuine unread-symbol claim (project identifier, no read anywhere) still injects", () => {
    // Mirrors the mt#3113 spec's literal AT wording. `tasks_estimate` is a
    // real project identifier (snake_case, resolvable shape) unaffected by
    // any of the leg-2 exclusions above.
    const result = detectCodeMechanismAssertion(TASKS_ESTIMATE_CLAIM_TEXT, "");
    expect(result.matched).toBe(true);
    expect(result.claims.map((c) => c.symbol)).toContain("tasks_estimate");
  });

  test("SYMBOL_STOPLIST additions are case-insensitive", () => {
    const text = "`MACOS` overrides the platform default and `Description` requires review.";
    const result = detectCodeMechanismAssertion(text, "");
    const syms = result.claims.map((c) => c.symbol);
    expect(syms).not.toContain("MACOS");
    expect(syms).not.toContain("Description");
  });

  test("PR #2236 R1/R2: bare (non-backticked) camelCase `macOS` is excluded via CAMEL_CASE_RE + stoplist", () => {
    // No backticks here -- CAMEL_CASE_RE extracts "macOS" from bare prose
    // independent of backtick-quoting; the stoplist check in
    // isPlausibleSymbol must still reject it.
    const text = "macOS overrides the platform resolver for this build.";
    const result = detectCodeMechanismAssertion(text, "");
    expect(result.claims.map((c) => c.symbol)).not.toContain("macOS");
    expect(result.matched).toBe(false);
  });

  test("PR #2236 R1/R2: bare (non-backticked) camelCase `CommonJS` is excluded via CAMEL_CASE_RE + stoplist", () => {
    const text = "CommonJS guards against duplicate module registration here.";
    const result = detectCodeMechanismAssertion(text, "");
    expect(result.claims.map((c) => c.symbol)).not.toContain("CommonJS");
    expect(result.matched).toBe(false);
  });
});

// Shared fixture for leg-3 relay-context tests: a claim set produced by
// detectCodeMechanismAssertion, reused across buildRelayCorpus/
// detectRelayContext coverage below.
const RELAY_CLAIM_TEXT = "`tasks_create` guards against duplicate task creation.";

function relayClaims(): Array<{ symbol: string; predicate: string }> {
  return detectCodeMechanismAssertion(RELAY_CLAIM_TEXT, "").claims;
}

// Shared mt#3113 fixtures, reused across the leg-3/leg-4 describe blocks
// below (custom/no-magic-string-duplication).
const TASKS_ESTIMATE_CLAIM_TEXT =
  "`tasks_estimate` overrides the default effort model for this task.";
const REASON_RELAYED_SUBAGENT_CONTENT = "relayed-subagent-content";
const REASON_RELAYED_PREAMBLE_PHRASE = "relayed-preamble-phrase";

describe("mt#3113 leg 3 — buildRelayCorpus (same-turn subagent-dispatch correlation)", () => {
  test("collects tool_result content correlated to an Agent tool_use by id", () => {
    const turn: TranscriptLine[] = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "Agent",
              id: "toolu_1",
              input: { prompt: "investigate mt#9999" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content:
                "The subagent found that `tasks_create` guards against duplicate task creation.",
            },
          ],
        },
      },
    ] as TranscriptLine[];
    const corpus = buildRelayCorpus(turn);
    expect(corpus).toContain("tasks_create");
  });

  test("SendMessage dispatch tool is also recognized", () => {
    const turn: TranscriptLine[] = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "SendMessage", id: "toolu_2", input: {} }],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_2", content: "resumed report text" },
          ],
        },
      },
    ] as TranscriptLine[];
    expect(buildRelayCorpus(turn)).toContain("resumed report text");
  });

  test("a non-dispatch tool's tool_result is NOT collected (R1 — Read is not a dispatch tool)", () => {
    const turn: TranscriptLine[] = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", name: "Read", id: "toolu_3", input: { file_path: "x.ts" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_3", content: "file contents here" }],
        },
      },
    ] as TranscriptLine[];
    expect(buildRelayCorpus(turn)).toBe("");
  });

  test("no dispatch tool_use in the turn -> empty corpus", () => {
    expect(buildRelayCorpus([])).toBe("");
  });

  test("PR #2236 R1/R2: top-level tool_use line shape (not nested in message.content) is also correlated", () => {
    // Mirrors buildVerificationCorpus's defensive top-level tool_use
    // fallback: a dispatch tool_use emitted as a top-level line, rather than
    // nested inside an assistant message's content array, must still
    // register a dispatch id so the correlated tool_result is collected.
    const turn = [
      {
        type: "tool_use",
        name: "Agent",
        id: "toolu_top_1",
        input: { prompt: "investigate mt#9999" },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_top_1",
              content: "top-level dispatch report",
            },
          ],
        },
      },
    ] as unknown as TranscriptLine[];
    expect(buildRelayCorpus(turn)).toContain("top-level dispatch report");
  });
});

describe("mt#3113 leg 3 — detectRelayContext", () => {
  test("(a) same-turn dispatch tool_result present -> relayed-subagent-content, regardless of literal symbol overlap", () => {
    const claims = relayClaims();
    const result = detectRelayContext(
      RELAY_CLAIM_TEXT,
      claims,
      "The subagent found that `tasks_create` guards against duplicate task creation."
    );
    expect(result.relayed).toBe(true);
    expect(result.reason).toBe(REASON_RELAYED_SUBAGENT_CONTENT);
    expect(result.relayedSymbols).toContain("tasks_create");
  });

  test("(a) UNRELATED same-turn subagent report still suppresses (no literal-symbol-match requirement)", () => {
    // A claim's literal symbol appearing in a same-turn tool_result is
    // ALREADY excluded via the pre-existing buildVerificationCorpus backing
    // mechanism (hadSameTurnRead), so (a) deliberately does NOT require
    // content overlap — it fires whenever a subagent report landed this
    // turn at all, even about a completely different topic.
    const claims = detectCodeMechanismAssertion(TASKS_ESTIMATE_CLAIM_TEXT, "").claims;
    const result = detectRelayContext(
      "unrelated assistant text",
      claims,
      "Investigated mt#9999: found 3 stale sessions to clean up."
    );
    expect(result.relayed).toBe(true);
    expect(result.reason).toBe(REASON_RELAYED_SUBAGENT_CONTENT);
  });

  test("(b) relay-preamble phrase in the prose, no same-turn dispatch corpus -> relayed-preamble-phrase", () => {
    const text = "The subagent reports that `unreadEnvGuard` overrides the default retry count.";
    const claims = detectCodeMechanismAssertion(text, "").claims;
    const result = detectRelayContext(text, claims, "");
    expect(result.relayed).toBe(true);
    expect(result.reason).toBe(REASON_RELAYED_PREAMBLE_PHRASE);
  });

  test("AT: task-notification phrase is recognized as a relay preamble", () => {
    const text = "Per the task-notification, `unreadEnvGuard` overrides the default retry count.";
    const claims = detectCodeMechanismAssertion(text, "").claims;
    const result = detectRelayContext(text, claims, "");
    expect(result.relayed).toBe(true);
  });

  test("no relay corpus and no preamble phrase -> not relayed (fresh, unverified assertion)", () => {
    const text = "`unreadEnvGuard` overrides the default retry count.";
    const claims = detectCodeMechanismAssertion(text, "").claims;
    const result = detectRelayContext(text, claims, "");
    expect(result.relayed).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  test("empty claim set -> not relayed regardless of corpus/prose", () => {
    const result = detectRelayContext("some text", [], "the subagent reports something");
    expect(result.relayed).toBe(false);
  });

  test("RELAY_PREAMBLE_PATTERNS matches the documented phrasings", () => {
    const samples = [
      "the subagent found that X does Y",
      "per the subagent's report, X does Y",
      "the dispatched agent's findings say X",
      "task-notification: X completed",
      "according to the subagent, X does Y",
    ];
    for (const s of samples) {
      expect(RELAY_PREAMBLE_PATTERNS.some((re) => re.test(s))).toBe(true);
    }
  });
});

describe("buildVerificationCorpus", () => {
  test("captures read-class tool_use INPUT and tool_result CONTENT; ignores non-read inputs", () => {
    const turn: TranscriptLine[] = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "packages/shared/src/exec.ts" } },
            // a non-read tool's input must NOT enter the corpus
            { type: "tool_use", name: "session_commit", input: { message: "secretMessageSymbol" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: EXEC_TS_SOURCE }],
        },
      },
    ];
    const corpus = buildVerificationCorpus(turn);
    expect(corpus).toContain("exec.ts"); // read-class input path
    expect(corpus).toContain("executeCommand"); // tool_result file content
    expect(corpus).not.toContain("secretMessageSymbol"); // non-read input excluded
  });

  test("Bash tool input is NOT collected (Bash is not read-class) (R1)", () => {
    const turn: TranscriptLine[] = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Bash", input: { command: "echo unrelatedSymbol" } }],
        },
      },
    ];
    // Bash input string must not enter the corpus → an unread-symbol claim still fires.
    expect(buildVerificationCorpus(turn)).not.toContain("unrelatedSymbol");
  });

  test("assistant-echoed tool_result block is NOT counted as backing (R1)", () => {
    const turn: TranscriptLine[] = [
      {
        // assistant-role line carrying a tool_result-typed block (echo / malformed)
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_result", content: "executeCommand clamps maxBuffer" }],
        },
      },
    ];
    // Role-gating: tool_result content is only authentic on USER-role lines.
    expect(buildVerificationCorpus(turn)).toBe("");
  });

  test("empty turn → empty corpus", () => {
    expect(buildVerificationCorpus([])).toBe("");
  });
});

describe("elideBlocksAndQuotes", () => {
  test("elides fenced blocks and blockquotes but KEEPS inline code", () => {
    const text = "Use `executeCommand` here.\n\n```\nfenced executeCommand\n```\n\n> quoted line";
    const out = elideBlocksAndQuotes(text);
    expect(out).toContain("`executeCommand`"); // inline kept
    expect(out).not.toContain("fenced executeCommand"); // fenced elided
    expect(out).not.toContain("quoted line"); // blockquote elided
    expect(out.length).toBe(text.length); // positions preserved
  });
});

// ---------------------------------------------------------------------------
// run() — dispatcher-compatible pure function (ADR-028 D1/D2 — mt#2652)
//
// No real fs needed: run() reads ctx.transcriptLines directly (resolved
// once by the dispatcher's D6 shared context) rather than re-parsing a
// transcript_path itself — so transcriptLines is built in-memory here.
// ---------------------------------------------------------------------------

function makeRunUserLine(text = "test user message"): TranscriptLine {
  return { type: "user", message: { role: "user", content: text } };
}

function makeRunAssistantLine(text: string): TranscriptLine {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
}

const RUN_HOOK_EVENT_NAME = "UserPromptSubmit";

const RUN_HOOK_INPUT: ClaudeHookInput = {
  session_id: "test-session",
  transcript_path: "/mock/transcript.jsonl",
  cwd: "/test",
  hook_event_name: RUN_HOOK_EVENT_NAME,
};

function makeCtx(transcriptLines: TranscriptLine[]): DispatchContext {
  return {
    event: RUN_HOOK_EVENT_NAME,
    hostCapSec: 15,
    budgets: { overallBudgetMs: 9000, fetchTimeoutMs: 4950, gitTimeoutMs: 1530 },
    transcriptCandidates: ["/mock/transcript.jsonl"],
    transcriptLines,
  };
}

// mt#3113 leg 4: run() now consults the real (fs-backed) claim-set dedup
// store by default. Existing tests below that don't specifically exercise
// dedup use this always-inject stub so they never touch real fs and stay
// deterministic across repeated `bun test` invocations (a real-store hit
// keyed on RUN_HOOK_INPUT's fixed session_id could otherwise get suppressed
// by a PRIOR test run's leftover cooldown state).
const ALWAYS_INJECT_DEPS = { shouldInjectClaimSetFn: () => true };

describe("run() (dispatcher-compatible)", () => {
  test("unread code-mechanism claim -> calibration record AND additionalContext (INJECTION_ENABLED=true, mt#3002)", () => {
    const transcriptLines = [
      makeRunUserLine(),
      makeRunAssistantLine(
        "The 1MB default `maxBuffer` is at its limit, and `executeCommand` clamps it."
      ),
      makeRunUserLine(),
    ];
    const outcome = run(RUN_HOOK_INPUT, makeCtx(transcriptLines), ALWAYS_INJECT_DEPS);
    expect(outcome?.calibration).toBeDefined();
    expect(INJECTION_ENABLED).toBe(true);
    expect(outcome?.additionalContext).toBeDefined();
    expect(outcome?.additionalContext).toContain("maxBuffer");
    const cal = outcome?.calibration as { claims: Array<{ symbol: string; predicate: string }> };
    expect(cal.claims.map((c) => c.symbol)).toContain("maxBuffer");
  });

  test("no match -> null (silent allow)", () => {
    const transcriptLines = [
      makeRunUserLine(),
      makeRunAssistantLine("The build passed and all tests are green."),
      makeRunUserLine(),
    ];
    expect(run(RUN_HOOK_INPUT, makeCtx(transcriptLines), ALWAYS_INJECT_DEPS)).toBeNull();
  });

  test("no transcript_path -> null", () => {
    const input: ClaudeHookInput = {
      session_id: "test",
      cwd: "/test",
      hook_event_name: RUN_HOOK_EVENT_NAME,
    };
    const ctx = makeCtx([makeRunUserLine(), makeRunAssistantLine("x"), makeRunUserLine()]);
    expect(run(input, ctx)).toBeNull();
  });

  test("legacy override env var suppresses detection and returns an audit line", () => {
    const transcriptLines = [
      makeRunUserLine(),
      makeRunAssistantLine("`executeCommand` clamps `maxBuffer` to 10MB."),
      makeRunUserLine(),
    ];
    process.env[OVERRIDE_ENV_VAR] = "1";
    try {
      const outcome = run(RUN_HOOK_INPUT, makeCtx(transcriptLines), ALWAYS_INJECT_DEPS);
      expect(outcome?.calibration).toBeUndefined();
      expect(outcome?.auditLines?.[0]).toContain("OVERRIDE");
    } finally {
      delete process.env[OVERRIDE_ENV_VAR];
    }
  });

  test("mt#3113 leg 1: hadSameTurnRead=true suppresses additionalContext but STILL logs the claim + reason (AT)", () => {
    // A DIFFERENT symbol (readHelper) is backed this turn; unreadEnvGuard's
    // own claim remains unbacked at claim level (hadSameTurnRead is a
    // TURN-level aggregate, per mt#2673 — unchanged detection semantics).
    // The mt#3113 injection-layer gate suppresses additionalContext anyway.
    const text = "`readHelper` is fine; `unreadEnvGuard` overrides the default when set.";
    const transcriptLines = [
      makeRunUserLine(),
      makeRunAssistantLine(text),
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "export function readHelper() {}" }],
        },
      } as TranscriptLine,
      makeRunUserLine(),
    ];
    const outcome = run(RUN_HOOK_INPUT, makeCtx(transcriptLines), ALWAYS_INJECT_DEPS);
    expect(outcome?.additionalContext).toBeUndefined();
    const cal = outcome?.calibration as {
      hadSameTurnRead: boolean;
      suppressionReasons: string[];
      claims: Array<{ symbol: string }>;
    };
    expect(cal.hadSameTurnRead).toBe(true);
    expect(cal.suppressionReasons).toContain("same-turn-read");
    // Detection-level contract is unchanged: the claim is still logged.
    expect(cal.claims.map((c) => c.symbol)).toContain("unreadEnvGuard");
  });

  test("mt#3113 leg 3 (via run()): a subagent report landing THIS turn suppresses an unrelated fresh claim (AT)", () => {
    // The subagent's report is about a DIFFERENT topic than the claim — its
    // tool_result content must NOT literally contain "tasks_estimate", or
    // the claim would already be excluded via the pre-existing
    // buildVerificationCorpus backing mechanism (hadSameTurnRead) rather
    // than reaching this leg-3-specific gate.
    const transcriptLines: TranscriptLine[] = [
      makeRunUserLine(),
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "Agent",
              id: "toolu_relay_1",
              input: { prompt: "investigate" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_relay_1",
              content: "Investigated mt#9999: found 3 stale sessions to clean up.",
            },
          ],
        },
      },
      makeRunAssistantLine(TASKS_ESTIMATE_CLAIM_TEXT),
      makeRunUserLine(),
    ];
    const outcome = run(RUN_HOOK_INPUT, makeCtx(transcriptLines), ALWAYS_INJECT_DEPS);
    expect(outcome?.additionalContext).toBeUndefined();
    const cal = outcome?.calibration as { suppressionReasons: string[]; hadSameTurnRead: boolean };
    expect(cal.hadSameTurnRead).toBe(false); // confirms this is leg 3, not leg 1
    expect(cal.suppressionReasons).toContain(REASON_RELAYED_SUBAGENT_CONTENT);
  });

  test("mt#3113 leg 4 (via run()): identical claim set two turns running injects at most once (AT)", () => {
    const transcriptLines = [
      makeRunUserLine(),
      makeRunAssistantLine(TASKS_ESTIMATE_CLAIM_TEXT),
      makeRunUserLine(),
    ];
    let injectCallCount = 0;
    const deps = {
      // Mirrors the real store's contract: first call for a signature
      // injects, subsequent calls within cooldown suppress.
      shouldInjectClaimSetFn: () => {
        injectCallCount++;
        return injectCallCount === 1;
      },
    };
    const first = run(RUN_HOOK_INPUT, makeCtx(transcriptLines), deps);
    expect(first?.additionalContext).toBeDefined();
    const firstCal = first?.calibration as { suppressionReasons: string[] };
    expect(firstCal.suppressionReasons).not.toContain("deduped");

    const second = run(RUN_HOOK_INPUT, makeCtx(transcriptLines), deps);
    expect(second?.additionalContext).toBeUndefined();
    const secondCal = second?.calibration as { suppressionReasons: string[] };
    expect(secondCal.suppressionReasons).toContain("deduped");
  });
});

describe("mt#3113 — computeSuppressionReasons (composition of legs 1/3/4)", () => {
  test("no suppression signals -> empty reasons array, injection proceeds", () => {
    const result = {
      matched: true,
      claims: [{ symbol: "foo", predicate: "clamps" }],
      hadSameTurnRead: false,
      backedClaimCount: 0,
    };
    const relay = { relayed: false, relayedSymbols: [] };
    const { reasons } = computeSuppressionReasons(result, relay, "sess-x", () => true);
    expect(reasons).toEqual([]);
  });

  test("all three signals compose into one reasons array", () => {
    const result = {
      matched: true,
      claims: [{ symbol: "foo", predicate: "clamps" }],
      hadSameTurnRead: true,
      backedClaimCount: 1,
    };
    const relay = {
      relayed: true,
      reason: REASON_RELAYED_PREAMBLE_PHRASE as const,
      relayedSymbols: [],
    };
    const { reasons, claimSetSignature } = computeSuppressionReasons(
      result,
      relay,
      "sess-x",
      () => false
    );
    expect(reasons).toEqual(["same-turn-read", REASON_RELAYED_PREAMBLE_PHRASE, "deduped"]);
    expect(typeof claimSetSignature).toBe("string");
    expect(claimSetSignature.length).toBeGreaterThan(0);
  });

  test("claimSetSignature is deterministic for the same claim set", () => {
    const result = {
      matched: true,
      claims: [{ symbol: "foo", predicate: "clamps" }],
      hadSameTurnRead: false,
      backedClaimCount: 0,
    };
    const relay = { relayed: false, relayedSymbols: [] };
    const a = computeSuppressionReasons(result, relay, "sess-x", () => true);
    const b = computeSuppressionReasons(result, relay, "sess-x", () => true);
    expect(a.claimSetSignature).toBe(b.claimSetSignature);
  });
});

// ---------------------------------------------------------------------------
// main()/CLI-path E2E (Bun.spawn) — mt#3002 R1
//
// The reviewer's blocking gap: run()/the dispatcher path is well-covered, but
// no test exercised main() — the actual CLI entrypoint the Claude Code harness
// invokes — now that INJECTION_ENABLED=true. This proves the emitted stdout
// JSON contract (hookSpecificOutput.hookEventName / .additionalContext) the
// harness parses, not just the in-process `run()` return shape. Mirrors the
// established pattern in pre-narration-detector.test.ts's "E2E" describe.
// ---------------------------------------------------------------------------

type CliJsonlLine = { type?: string; message?: { role?: string; content?: unknown } };

function cliUserLine(): CliJsonlLine {
  return { type: "user", message: { role: "user", content: "test user message" } };
}

function cliAssistantLine(text: string): CliJsonlLine {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
}

function buildCliTranscriptJSONL(lines: CliJsonlLine[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

// mt#3113 leg 4: main() consults the real (fs-backed) claim-set dedup store,
// keyed by session_id. A FIXED literal session_id here would let one test
// RUN's cooldown state suppress additionalContext on the NEXT `bun test`
// invocation within the hour (real store persists across process runs in
// the same home dir) -- a random suffix per hook-input construction keeps
// every CLI invocation's dedup state independent, matching this file's
// pure-function tests (which bypass the real store entirely via
// ALWAYS_INJECT_DEPS) instead of depending on test-run timing.
function makeCliHookInput(transcriptPath: string): ClaudeHookInput {
  return {
    session_id: `test-session-cma-cli-${crypto.randomUUID()}`,
    transcript_path: transcriptPath,
    cwd: "/tmp",
    hook_event_name: RUN_HOOK_EVENT_NAME,
  } as ClaudeHookInput;
}

async function invokeCliHook(
  input: ClaudeHookInput,
  env: Record<string, string> = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const hookPath = new URL("code-mechanism-assertion-detector.ts", import.meta.url).pathname;
  const proc = Bun.spawn(["bun", "run", hookPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  proc.stdin.write(JSON.stringify(input));
  proc.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

describe("code-mechanism-assertion-detector main()/CLI-path E2E (mt#3002 R1)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cma-e2e-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("unread genuine claim -> exit 0, hookSpecificOutput/additionalContext JSON contract (INJECTION_ENABLED=true)", async () => {
    const p = join(dir, "claim.jsonl");
    writeFileSync(
      p,
      buildCliTranscriptJSONL([
        cliUserLine(),
        cliAssistantLine(GENUINE_UNBACKED_CLAIM_TEXT),
        cliUserLine(),
      ]),
      "utf8"
    );
    const { exitCode, stdout } = await invokeCliHook(makeCliHookInput(p));
    expect(exitCode).toBe(0);

    // The harness parses this exact envelope from stdout — assert the real
    // shape, not a substring match, so a contract drift (renamed field,
    // wrong hookEventName, non-JSON output) fails this test.
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
    };
    expect(parsed.hookSpecificOutput?.hookEventName).toBe(RUN_HOOK_EVENT_NAME);
    expect(typeof parsed.hookSpecificOutput?.additionalContext).toBe("string");
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("tasks_create");
    expect(parsed.hookSpecificOutput?.additionalContext).toContain(
      "code-mechanism-assertion-detector"
    );
  });

  test("no code-mechanism claim -> exit 0, empty stdout (silent allow) via the CLI path", async () => {
    const p = join(dir, "no-claim.jsonl");
    writeFileSync(
      p,
      buildCliTranscriptJSONL([
        cliUserLine(),
        cliAssistantLine("The build passed and all tests are green."),
        cliUserLine(),
      ]),
      "utf8"
    );
    const { exitCode, stdout } = await invokeCliHook(makeCliHookInput(p));
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("file-name/hex-id FP fixtures produce no output via the CLI path (mt#3002)", async () => {
    const p = join(dir, "fp.jsonl");
    writeFileSync(
      p,
      buildCliTranscriptJSONL([
        cliUserLine(),
        cliAssistantLine(
          "See `hook-files.mdc` for how the override behaves; the commit `a30378971` guards against the regression."
        ),
        cliUserLine(),
      ]),
      "utf8"
    );
    const { exitCode, stdout } = await invokeCliHook(makeCliHookInput(p));
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("R13 sourcing/provenance sentence fires via the CLI path (mt#3050)", async () => {
    const p = join(dir, "r13.jsonl");
    writeFileSync(
      p,
      buildCliTranscriptJSONL([
        cliUserLine(),
        cliAssistantLine(
          "the router suggestion is sourced from the existing `tasks_route` / `tasks_estimate` seam."
        ),
        cliUserLine(),
      ]),
      "utf8"
    );
    const { exitCode, stdout } = await invokeCliHook(makeCliHookInput(p));
    expect(exitCode).toBe(0);

    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
    };
    expect(parsed.hookSpecificOutput?.hookEventName).toBe(RUN_HOOK_EVENT_NAME);
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("tasks_route");
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("tasks_estimate");
    // mt#3050: the injection copy must cover capability/sourcing claims, not
    // only behavior claims — a sourcing-only fixture must not read as though
    // it was accused of a behavior claim.
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("capability");
  });

  test("sourcing/provenance non-claim prose fixtures produce no output via the CLI path (mt#3050)", async () => {
    const p = join(dir, "sourcing-fp.jsonl");
    writeFileSync(
      p,
      buildCliTranscriptJSONL([
        cliUserLine(),
        cliAssistantLine(
          "The estimate comes from a rough guess, not a formula, and our revenue is backed by strong customer retention."
        ),
        cliUserLine(),
      ]),
      "utf8"
    );
    const { exitCode, stdout } = await invokeCliHook(makeCliHookInput(p));
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("");
  });
});
