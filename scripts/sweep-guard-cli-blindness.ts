#!/usr/bin/env bun
// mt#4536 — which PreToolUse guards cannot see a CLI-routed invocation of the
// capability they watch?
//
// ## Why a script rather than a hand-written table
//
// The answer changes whenever a guard is registered, a matcher is widened, or a
// command gains a CLI surface. A table in a spec is a claim about a moving
// population, and this task exists BECAUSE four separate tasks each rediscovered
// the same class locally — a stale table is how a fifth would.
//
// ## The two populations, and why reading one is not enough
//
// A guard reaches the PreToolUse event through one of two routes, and they have
// DIFFERENT registration sites:
//
//   1. **Directly registered** in `.claude/settings.json` — its own process,
//      spawned by the harness against that block's `matcher`.
//   2. **Dispatcher-routed** — registered in `GUARD_REGISTRY` with its own
//      `matcher`, and run in-process by a `dispatch-*.ts` entrypoint that
//      settings.json routes.
//
// Reading only `GUARD_REGISTRY` (e.g. via `scripts/dump-guard-registry.ts`)
// misses population 1 entirely — including `check-task-spec-read`, which is
// mt#4380's guard and one of this task's four known instances. That is exactly
// the failure AT1's negative control exists to catch, and it caught it here
// during authoring: the first draft of this sweep read the registry alone.
//
// ## What this does NOT cover, stated rather than discovered
//
// - **Corpus blindness.** A transcript scanner like `code-mechanism-assertion-
//   detector` registers on `UserPromptSubmit` with NO matcher — it runs on every
//   turn and sees the whole transcript. Its CLI blindness (mt#4525, mt#4534) is an
//   in-detector filter over tool_use RECORDS (`ARTIFACT_TOOL_RE`), not a
//   registration matcher, so no registration sweep can find it. Section 2 lists
//   the scanners so the class is visible; deciding their fix is SC3's job.
// - **Whether a guard, once it RUNS on a Bash call, can actually parse the
//   command.** Registration is necessary, not sufficient. This sweep answers
//   reachability only.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GUARD_REGISTRY } from "../.minsky/hooks/registry";

const REPO_ROOT = resolve(import.meta.dir, "..");

/**
 * Read and parse a repo JSON file, failing LOUDLY with the path and cause.
 *
 * Both of this sweep's inputs are generated or hand-maintained files that can be
 * absent (a fresh clone before `build-completion-manifest`) or malformed (a
 * half-written settings.json). Unwrapped, either produces a raw `ENOENT` or
 * `SyntaxError` naming no context (PR #3343 R1).
 *
 * **It throws rather than degrading to a partial result, and that is the point.**
 * A sweep that silently skipped an unreadable input would under-report blind
 * guards and read as a clean table — the same silent-coverage-loss failure this
 * whole task is about. Applied to BOTH inputs, not only the one flagged: the
 * settings.json read is the identical shape and would have been the next instance.
 */
export function readRepoJson(relPath: string): unknown {
  const abs = resolve(REPO_ROOT, relPath);
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch (err) {
    throw new Error(
      `sweep-guard-cli-blindness: cannot read ${relPath} (${abs}): ` +
        `${err instanceof Error ? err.message : String(err)}. The sweep needs it to classify ` +
        `guards; refusing to emit a partial table that would under-report blind guards.`
    );
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `sweep-guard-cli-blindness: ${relPath} is not valid JSON: ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Regex syntax a plain `split("|")` would mis-handle. `|` and a bare `*` are excluded deliberately. */
const NON_LITERAL_SYNTAX = /[()[\]\\.+?^${}]/;

/**
 * Every literal alternative of a matcher. `*` and an absent matcher mean "all tools".
 *
 * **Splitting on `|` is sound only for a LITERAL alternation, so that assumption is
 * asserted rather than assumed (PR #3343 R1).** A matcher using a group, an escape or
 * a quantifier would split into fragments that are not tool names, and every verdict
 * for that guard would be wrong — SILENTLY, because a fragment simply fails to
 * resolve and reads as "no CLI route". A sweep whose coverage claim degrades without
 * saying so is this task's own subject, so it throws instead of guessing.
 *
 * Measured 2026-08-25: all 20 distinct matchers across both populations are plain `|`
 * alternations or `*`, and none carries other regex syntax. This check therefore
 * fires on nothing today; it exists for the matcher that changes that.
 */
export function matcherAlternatives(matcher: string | undefined): string[] {
  if (matcher === undefined || matcher === "*") return ["*"];
  if (NON_LITERAL_SYNTAX.test(matcher)) {
    throw new Error(
      `sweep-guard-cli-blindness: matcher ${JSON.stringify(matcher)} is not a literal ` +
        `alternation. Splitting it on "|" yields fragments that are not tool names, so every ` +
        `verdict for this guard would be silently wrong. Teach the sweep this syntax before ` +
        `trusting its table.`
    );
  }
  return matcher
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The two tool names through which a subprocess command string reaches a hook. */
const COMMAND_STRING_TOOLS = ["Bash", "mcp__minsky__session_exec"];

/**
 * Does this matcher put the guard on the CLI's path?
 *
 * Tested with **`RegExp`, not string equality** (PR #3343 R1), so this reproduces
 * what the dispatcher actually does — `new RegExp(reg.matcher).test(toolName)` in
 * `getGuardsForEvent` — rather than a parallel notion of matching that could diverge
 * from it. Note the dispatcher's test is UNANCHORED and this inherits that on
 * purpose: reproducing the real dispatch behaviour, including its quirks, is the
 * point of a sweep about what guards actually see.
 *
 * A matcher that will not compile is treated as matching nothing, which is also
 * `getGuardsForEvent`'s behaviour for a malformed matcher.
 */
export function observesCommandStrings(matcher: string | undefined, alts: string[]): boolean {
  if (matcher === undefined || alts.includes("*")) return true;
  let re: RegExp;
  try {
    re = new RegExp(matcher);
  } catch {
    return false;
  }
  return COMMAND_STRING_TOOLS.some((t) => re.test(t));
}

/**
 * Command ids the CLI actually exposes, from the generated completion manifest.
 *
 * Keyed on a separator-free normalization so an MCP tool name
 * (`tasks_status_set`) and a registry command id (`tasks.status.set`) compare
 * equal without hard-coding either spelling. mt#4144 stamps `commandId` onto
 * each manifest leaf; this reads that stamp rather than re-deriving the mapping.
 */
function cliCommandKeys(): Set<string> {
  const manifest = readRepoJson("src/generated/completion-manifest.json");
  const keys = new Set<string>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const rec = node as Record<string, unknown>;
    if (typeof rec["commandId"] === "string") keys.add(normalizeKey(rec["commandId"]));
    const subs = rec["subcommands"];
    if (Array.isArray(subs)) for (const s of subs) walk(s);
  };
  walk(manifest);
  return keys;
}

function normalizeKey(s: string): string {
  return s.replace(/[._-]/g, "").toLowerCase();
}

/**
 * Capabilities reachable through a DIFFERENTLY-NAMED CLI command (mt#4536).
 *
 * **This overlay is the whole point of the sweep, not a footnote.** A name-matched
 * comparison answers "is there a CLI command spelled like this MCP tool" — and for
 * the load-bearing case the answer is NO while the capability is fully reachable:
 * `tasks_spec_patch` has no CLI twin, yet `minsky tasks edit --spec-file` writes
 * the same spec. That IS mt#4525's originating incident, and a name-matched sweep
 * clears the guard that missed it.
 *
 * Curated and therefore stale-able — the same failure mode this task is about, so
 * it is declared here rather than buried: **an entry missing from this map reads as
 * "no CLI route" and is silently wrong.** Each entry cites how it was established.
 */
const CAPABILITY_ALIASES: Readonly<Record<string, { via: string; basis: string }>> = {
  // Verified: `tasks.spec.patch` and `tasks.spec.search-replace` carry no manifest
  // commandId, but `tasks.edit --spec-file` reads a file and uses it as the spec
  // body (mt#4525 extracted `authored-spec-text.ts` for exactly this path).
  mcp__minsky__tasks_spec_patch: {
    via: "minsky tasks edit --spec-file",
    basis: "mt#4525 — the originating incident routed spec writes through it",
  },
  mcp__minsky__tasks_spec_search_replace: {
    via: "minsky tasks edit --spec-file",
    basis: "same body path as tasks_spec_patch",
  },
};

interface Row {
  guard: string;
  route: "direct" | "dispatcher";
  matcher: string;
  verdict: string;
  note: string;
}

function classify(
  guard: string,
  route: Row["route"],
  matcher: string | undefined,
  cli: Set<string>
): Row {
  const alts = matcherAlternatives(matcher);
  const shown = matcher ?? "(none — all tools)";

  if (observesCommandStrings(matcher, alts)) {
    return {
      guard,
      route,
      matcher: shown,
      verdict: "SEES CLI",
      note: "matcher already covers the command-string surface",
    };
  }

  const minskyTools = alts.filter((a) => a.startsWith("mcp__minsky__"));
  if (minskyTools.length === 0) {
    return {
      guard,
      route,
      matcher: shown,
      verdict: "N/A",
      note: "watches a harness/third-party tool with no Minsky CLI equivalent",
    };
  }

  const reachable: string[] = [];
  for (const tool of minskyTools) {
    const alias = CAPABILITY_ALIASES[tool];
    if (alias !== undefined) {
      reachable.push(`${tool} → ${alias.via}`);
      continue;
    }
    if (cli.has(normalizeKey(tool.replace("mcp__minsky__", "")))) {
      reachable.push(`${tool} → minsky ${tool.replace("mcp__minsky__", "").replace(/_/g, " ")}`);
    }
  }

  if (reachable.length === 0) {
    return {
      guard,
      route,
      matcher: shown,
      verdict: "MCP-ONLY",
      note: "no CLI route to any watched capability",
    };
  }
  return { guard, route, matcher: shown, verdict: "BLIND", note: reachable.join("; ") };
}

/** PreToolUse hooks registered directly in settings.json (not via a dispatcher). */
function directRegistrations(): Array<{ guard: string; matcher: string }> {
  const parsed = readRepoJson(".claude/settings.json") as {
    hooks?: { PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }> };
  };
  const out: Array<{ guard: string; matcher: string }> = [];
  for (const block of parsed.hooks?.PreToolUse ?? []) {
    for (const h of block.hooks ?? []) {
      const cmd = h.command ?? "";
      const base = cmd.slice(cmd.lastIndexOf("/") + 1);
      if (base.startsWith("dispatch-")) continue; // routed population, covered below
      out.push({ guard: base.replace(/\.ts$/, ""), matcher: block.matcher ?? "*" });
    }
  }
  return out;
}

/**
 * The sweep, as a value rather than a print — so AT1's negative control can be a
 * TEST rather than a one-time observation an author reports having made.
 */
export function runSweep(): Row[] {
  const cli = cliCommandKeys();
  const rows: Row[] = [];

  for (const { guard, matcher } of directRegistrations()) {
    rows.push(classify(guard, "direct", matcher, cli));
  }
  for (const reg of GUARD_REGISTRY) {
    if (reg.event !== "PreToolUse") continue;
    rows.push(classify(reg.name, "dispatcher", reg.matcher, cli));
  }

  rows.sort((a, b) => a.verdict.localeCompare(b.verdict) || a.guard.localeCompare(b.guard));
  return rows;
}

export type { Row };

if (import.meta.main) {
  const rows = runSweep();
  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] ?? 0) + 1;
    return acc;
  }, {});

  console.log("| Guard | Route | Matcher | Verdict | Note |");
  console.log("| --- | --- | --- | --- | --- |");
  for (const r of rows) {
    console.log(
      `| \`${r.guard}\` | ${r.route} | \`${r.matcher}\` | **${r.verdict}** | ${r.note} |`
    );
  }
  console.log(
    `\nTotals: ${JSON.stringify(counts)} across ${rows.length} PreToolUse registrations.`
  );
}
