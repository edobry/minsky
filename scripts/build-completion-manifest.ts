#!/usr/bin/env bun
/**
 * Build the shell-completion manifest by force-loading the full CLI command
 * tree and walking it. The output is a static JSON consumed by the
 * `completion-server` handler at TAB time.
 *
 * Why a static manifest (not live tree-walking at completion time):
 * lazy-loaded heavy commands cost ~700ms to import; that blows the 300ms
 * completion-latency budget. The manifest is generated once at build time
 * and read in <10ms at completion time. See mt#1892 §D1.
 *
 * Two-pass build (mt#1893):
 *   1. **Commander tree walk** — capture the structural shape (command names,
 *      subcommands, option flags) and the `takesValue` boolean per option.
 *   2. **Shared-registry walk** — for each shared command, introspect its
 *      Zod parameter schemas to extract enum values, then inject them into
 *      the matching options in the manifest.
 *
 * Trigger: `bun run scripts/build-completion-manifest.ts` (also wired into
 * `bun run build` via the `build:completion-manifest` script in package.json).
 *
 * Auto-regeneration (mt#2622): `src/hooks/pre-commit.ts`'s
 * `runCompletionManifestRegen` step runs `bun run build:completion-manifest`
 * on every commit and re-stages the output if it changed, so the committed
 * manifest never drifts from the CLI tree it describes. Manual invocation is
 * only needed for local inspection — the pre-commit hook keeps it correct
 * automatically, and `bun run build` regenerates it again defensively before
 * bundling (covers commits made with `--no-verify` or predating this fix).
 */
import "reflect-metadata";
import { writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import type { Command } from "commander";
import { z } from "zod";
import { format as prettierFormat, resolveConfig } from "prettier";

// Force the `needsAll` path inside createCli — this loads every lazy-loaded
// heavy command (mcp, github, context, lint, init, setup, compile, cockpit)
// so the manifest sees the full tree, not just the shared-registry commands.
// See src/cli.ts:124-127 for the needsAll predicate.
process.argv = [...process.argv.slice(0, 2), "--help"];

// Prevent src/cli.ts from auto-running main() on import. The build script needs
// createCli for the registration-only path; running parseAsync would print --help
// and exit before we walk the tree. See src/cli.ts MINSKY_SKIP_CLI_AUTORUN gate.
process.env.MINSKY_SKIP_CLI_AUTORUN = "1";

const { createCli } = await import("../src/cli");
const { createCliContainer } = await import("../src/composition/cli");
const { sharedCommandRegistry } = await import("../src/adapters/shared/command-registry");
const { paramNameToFlag } = await import("../src/adapters/shared/schema-bridge");

interface ManifestOption {
  /** All flag forms for this option, e.g. ["-b", "--backend"]. */
  flags: string[];
  description?: string;
  /** Whether the option consumes the next argument as its value. */
  takesValue?: boolean;
  /** Finite enum values from the Zod schema, if extracted. */
  values?: string[];
}

/**
 * A Commander positional argument (`cmd.registeredArguments`), distinct from
 * flag-style `Option`s. Commander tracks these separately (`command.argument(...)`)
 * and they never appear in `cmd.options` — see mt#2984.
 */
interface ManifestArgument {
  /** Argument name as declared, e.g. "id" (without the <>/[] wrapper). */
  name: string;
  description?: string;
  /** True for `<name>` (required); false for `[name]` (optional). */
  required: boolean;
  /** True for a variadic argument (`<name...>` / `[name...]`). */
  variadic?: boolean;
}

interface ManifestCommand {
  name: string;
  description?: string;
  subcommands?: ManifestCommand[];
  options?: ManifestOption[];
  /** Positional arguments declared via `command.argument(...)`. */
  arguments?: ManifestArgument[];
  /**
   * The shared-registry command id this CLI leaf was generated from (mt#4144) —
   * e.g. `tasks.status.set` for `minsky tasks status set`.
   *
   * Stamped in pass 2 for every registry command whose CLI node resolves. Its
   * consumer is `.minsky/hooks/detect-cli-mcp-substitution.ts`, which needs to
   * answer "does this CLI invocation have an MCP equivalent?" without importing
   * domain code — a PreToolUse hook that reached the registry directly would owe
   * `ensureHookDomainBootstrap()` (config init + a DB-capable provider resolve)
   * on every `Bash` call, per `custom/require-hook-domain-bootstrap`.
   *
   * The MCP tool name is a pure transform of this id (`.` → `_`, prefixed
   * `mcp__minsky__`), because the MCP adapter registers each command under
   * `name: command.id` (`src/adapters/mcp/shared-command-integration.ts:533`).
   * So the id is the whole mapping; the hook needs nothing else.
   *
   * ABSENT on a node that is not a registry leaf (a category container like
   * `tasks`, or a hand-built Commander command with no registry entry). Absence
   * means "no MCP equivalent", which is exactly the read the hook wants.
   */
  commandId?: string;
}

/**
 * Internal commands that should NEVER appear in user-facing completion output.
 * Commander 14 has no public `hidden` getter, so we can't introspect the
 * `hidden: true` flag set via `cli.addCommand(cmd, { hidden: true })`. The
 * denylist enumerates known internal commands by exact name; any future
 * hidden command must be added here.
 */
const HIDDEN_COMMAND_NAMES: ReadonlySet<string> = new Set(["completion-server"]);

function walkCommand(cmd: Command): ManifestCommand {
  const node: ManifestCommand = { name: cmd.name() };
  const desc = cmd.description();
  if (desc) node.description = desc;

  const visibleSubs = cmd.commands.filter((s) => !HIDDEN_COMMAND_NAMES.has(s.name()));
  if (visibleSubs.length > 0) {
    node.subcommands = visibleSubs.map(walkCommand);
  }

  // Skip options hidden from the CLI surface (e.g. server-injected-only params
  // flagged `cliHidden` — mt#3121): they are not user-passable, so they must not
  // appear as shell completions. Commander sets `Option.hidden` for these.
  const visibleOptions = cmd.options.filter((o) => !(o as { hidden?: boolean }).hidden);
  if (visibleOptions.length > 0) {
    node.options = visibleOptions.map((o) => {
      const flags: string[] = [];
      if (o.short) flags.push(o.short);
      if (o.long) flags.push(o.long);
      const opt: ManifestOption = { flags };
      if (o.description) opt.description = o.description;
      // Commander 14: `Option.required` = "option takes a required argument";
      // `Option.optional` = "option takes an optional argument". Either ⇒ takes value.
      if (o.required || o.optional) opt.takesValue = true;
      return opt;
    });
  }

  // Positional arguments (`command.argument("<id>", ...)`) are tracked by
  // Commander separately from flag-style options (`cmd.registeredArguments`,
  // not `cmd.options`). Required positional args (e.g. the `<id>` arg on the
  // 4 asks.* commands: respond/edit/wait-for-response/get) previously had no
  // completion-manifest representation at all. See mt#2984.
  if (cmd.registeredArguments.length > 0) {
    node.arguments = cmd.registeredArguments.map((a) => {
      const arg: ManifestArgument = { name: a.name(), required: a.required };
      if (a.description) arg.description = a.description;
      if (a.variadic) arg.variadic = true;
      return arg;
    });
  }

  return node;
}

/**
 * Unwrap Zod wrappers (optional/default/nullable) to reach the inner type.
 * Zod v4 represents wrappers as `{ _def: { type: "<wrapper>", innerType: <schema> } }`.
 */
function unwrapZod(schema: z.ZodType): z.ZodType {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cur: any = schema;
  while (cur?._def && ["optional", "default", "nullable"].includes(cur._def.type)) {
    cur = cur._def.innerType;
  }
  return cur as z.ZodType;
}

/**
 * Extract a finite set of enum-like values from a Zod schema, if any.
 *
 * Recognized shapes (Zod v4):
 *   - `z.enum([...])` — single source of truth via `.options` accessor.
 *   - `z.literal("x")` — a one-value enum.
 *   - `z.union([z.literal(...), ...])` — multi-value enum spelled as union.
 *   - Any of the above wrapped in `.optional()`, `.default(...)`, `.nullable()`.
 *
 * Returns `undefined` for free-form schemas (`z.string()`, `z.number()`,
 * mixed unions, etc.). Defensive against unexpected shapes — never throws.
 */
function extractEnumValues(schema: z.ZodType): string[] | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inner: any = unwrapZod(schema);
  if (!inner?._def) return undefined;

  if (inner._def.type === "enum") {
    // `.options` is the public accessor returning string[] in Zod v4.
    const opts = inner.options;
    if (Array.isArray(opts)) return opts.map((v: unknown) => String(v));
    return undefined;
  }

  if (inner._def.type === "literal") {
    // Prefer the public `.value` accessor over `_def.values` for resilience
    // across Zod minor versions. Zod v4 _def shape uses `values` as an array
    // (verified empirically), but the public accessor is the documented contract.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lit = inner as any;
    if (lit.value !== undefined) return [String(lit.value)];
    // Fallback to _def.values for safety if the accessor isn't present.
    if (Array.isArray(inner._def.values)) {
      return inner._def.values.map((v: unknown) => String(v));
    }
    return undefined;
  }

  if (inner._def.type === "union") {
    // Union of literals = enum-like. Bail if any non-literal alternative.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = inner._def.options as any[];
    if (!Array.isArray(opts)) return undefined;
    const collected: string[] = [];
    for (const o of opts) {
      const unwrapped = unwrapZod(o);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const optAny = unwrapped as any;
      if (optAny?._def?.type !== "literal") return undefined;
      // Prefer the public `.value` accessor (singular) — same reasoning as above.
      if (optAny.value !== undefined) {
        collected.push(String(optAny.value));
        continue;
      }
      // Fallback to _def.values array.
      if (Array.isArray(optAny._def.values)) {
        for (const v of optAny._def.values) collected.push(String(v));
        continue;
      }
      return undefined;
    }
    return collected;
  }

  return undefined;
}

/**
 * Inject `values` into a manifest option matching the given flag.
 * Mutates `node.options` in place.
 */
function injectValues(node: ManifestCommand, flagName: string, values: string[]): boolean {
  if (!node.options) return false;
  for (const opt of node.options) {
    if (opt.flags.includes(`--${flagName}`)) {
      opt.values = values;
      return true;
    }
  }
  return false;
}

/** Walk one literal path of node names from `root`. */
function walkPath(root: ManifestCommand, segments: string[]): ManifestCommand | undefined {
  let cur: ManifestCommand | undefined = root;
  for (const seg of segments) {
    if (!cur?.subcommands) return undefined;
    cur = cur.subcommands.find((s) => s.name === seg);
    if (!cur) return undefined;
  }
  return cur;
}

/**
 * Locate a manifest node for a registry command.
 *
 * The dotted id is NOT always the CLI path, which is why this takes the category
 * and the leaf name rather than the id alone. `CategoryCommandHandler`'s path
 * builder (`src/adapters/shared/bridges/cli/category-command-handler.ts:192-218`)
 * mounts every command under its lower-cased category and then branches:
 *
 *   - id STARTS WITH `<category>.` → strip the prefix and split the remainder.
 *     `tasks.status.set` / `TASKS` → `minsky tasks status set`.
 *   - id contains dots but does NOT start with the category → split the whole id
 *     under the category name. `asks.list` / `TOOLS` → `minsky tools asks list`.
 *   - the leaf name does not match the last id segment → the name is appended.
 *
 * Trying the candidates in that order reproduces the handler's outcome without
 * importing its private method — which is deliberate. This function and that one
 * are the two-places-must-stay-in-sync pattern `custom/require-hook-domain-bootstrap`
 * (mt#3178) and `custom/require-guard-outcome-in-fire-log` (mt#3920) both exist to
 * warn about, so the drift is bounded by construction instead: a candidate that
 * resolves to a real node is confirmed against the Commander tree the CLI actually
 * built, and one that does not simply misses. A miss under-reports coverage; it
 * never stamps a WRONG id.
 *
 * Returns undefined when no candidate resolves — the command may be lazy-loaded
 * and not yet wired into the tree, or hidden.
 */
function findNodeByCommandId(
  root: ManifestCommand,
  commandId: string,
  category?: string,
  leafName?: string
): ManifestCommand | undefined {
  const idSegments = commandId.split(".");
  const cat = category?.toLowerCase();

  // ORDER IS LOAD-BEARING (PR #3004 R1 BLOCKING). Every command mounts UNDER its
  // category, so the category-aware path is the correct one and must be tried
  // FIRST. The first draft tried bare `idSegments` first: for `asks.list` under
  // `TOOLS` that probes `['asks','list']` at the root before the correct
  // `['tools','asks','list']`, so the day a top-level `asks` command with a
  // `list` child exists, it stamps the WRONG node — silently, and against this
  // function's own promise never to.
  const candidates: string[][] = [];
  if (cat) {
    if (idSegments[0] === cat) {
      // Id already carries the category: `tasks.status.set` -> `tasks status set`.
      candidates.push(idSegments);
    } else {
      // Id does not: `asks.list` under TOOLS -> `tools asks list`.
      candidates.push([cat, ...idSegments]);
    }
  }
  // Bare id last, as a fallback for a command whose category is absent or does
  // not correspond to a top-level Commander node.
  candidates.push(idSegments);

  // The name-appended variants mirror the handler's `nameMatchesLastIdSegment`
  // fallback. Only tried when the name is not already the last segment, so a
  // well-formed id never pays for them.
  if (leafName && idSegments[idSegments.length - 1] !== leafName) {
    for (const base of [...candidates]) candidates.push([...base, leafName]);
  }

  const seen = new Set<string>();
  for (const segments of candidates) {
    const key = segments.join("\n");
    if (seen.has(key)) continue;
    seen.add(key);
    const node = walkPath(root, segments);
    if (node) return node;
    // NOT gated on leaf-ness, though the review suggested it and it looks right.
    // `setup` falsifies it: it is a registry command AND a container (`setup db`,
    // `setup github-app` are their own registry commands). Requiring a leaf drops
    // it — measured, 227 stamped -> 226 with `setup` unresolved — and the
    // manifest then reads "no MCP equivalent" for a command that has one
    // (`mcp__minsky__setup`), which is the exact misread the check was meant to
    // prevent. `walkPath` already returns undefined unless EVERY segment matched,
    // so a partial match cannot resolve here; the real mis-stamp hazard was
    // candidate ORDER, fixed above. A container carrying its own `commandId`
    // beside children carrying theirs is correct, not a contract violation.
  }
  return undefined;
}

async function main() {
  const container = await createCliContainer();
  try {
    const cli = await createCli(container);

    // Pass 1: structural walk of the Commander tree.
    const manifest = walkCommand(cli);

    // Pass 2: enrich with Zod-derived enum values from the shared registry, and
    // stamp each resolved leaf with its registry command id (mt#4144).
    let valuesInjected = 0;
    let valuesAttempted = 0;
    let idsStamped = 0;
    const unresolvedIds: string[] = [];
    for (const cmd of sharedCommandRegistry.getAllCommands()) {
      const node = findNodeByCommandId(manifest, cmd.id, cmd.category, cmd.name);
      if (!node) {
        // NAMED, not just counted (PR #3004 R1). An unresolved id and a genuine
        // non-registry leaf are indistinguishable in the manifest — both simply
        // lack `commandId`, and the consumer reads absence as "no MCP
        // equivalent". A silent count cannot tell those apart after the fact, so
        // the ids are printed for triage.
        unresolvedIds.push(cmd.id);
        continue; // command not in the visible Commander tree
      }
      node.commandId = cmd.id;
      idsStamped++;
      for (const [paramName, paramDef] of Object.entries(cmd.parameters || {})) {
        const values = extractEnumValues(paramDef.schema);
        if (!values || values.length === 0) continue;
        valuesAttempted++;
        const flagName = paramNameToFlag(paramName);
        if (injectValues(node, flagName, values)) valuesInjected++;
      }
    }

    // Generation banner for the generated-file-edit guard hook (CLAUDE.md).
    // The "do not edit directly" phrase matches the hook's verbal pattern.
    const wrapped = {
      _generated: "by scripts/build-completion-manifest.ts — do not edit directly",
      ...manifest,
    };

    const outPath = join(import.meta.dir, "..", "src", "generated", "completion-manifest.json");
    mkdirSync(dirname(outPath), { recursive: true });

    // Format the serialized manifest with the project's Prettier (resolving the
    // same .prettierrc.json config that `format:check` uses) so the generator's
    // own output byte-matches the committed copy. Without this, the raw
    // `JSON.stringify` output (expanded short arrays, etc.) diverges from the
    // Prettier-formatted committed file, so every `bun run build` re-dirties the
    // tracked file and blocks `git pull --ff-only` (mt#2732). Making the
    // generator the single source of canonical format means all invocation
    // paths (build / pre-commit / manual) emit identical output — no downstream
    // re-formatting pass is needed (the mt#2622 pre-commit prettier pass was
    // removed as redundant alongside this change).
    //
    // Prettier normalizes the trailing newline, so `JSON.stringify` alone (no
    // manual "\n") suffices. `resolveConfig` returns null when no config file is
    // found — coalesce to {} so the options spread is always well-defined.
    const rawJson = JSON.stringify(wrapped, null, 2);
    const prettierConfig = (await resolveConfig(outPath)) ?? {};
    const formatted = await prettierFormat(rawJson, { ...prettierConfig, parser: "json" });
    writeFileSync(outPath, formatted);

    console.log(
      `Wrote completion manifest: ${outPath}\n` +
        `  Enum-value injections: ${valuesInjected}/${valuesAttempted} (` +
        `${valuesAttempted - valuesInjected} options not found in Commander tree)\n` +
        `  Command-id stamps: ${idsStamped} stamped, ${unresolvedIds.length} unresolved${
          unresolvedIds.length > 0 ? `\n    unresolved: ${unresolvedIds.join(", ")}` : ""
        }`
    );
  } finally {
    await container.close();
  }
}

await main();
