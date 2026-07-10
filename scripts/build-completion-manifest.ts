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

interface ManifestCommand {
  name: string;
  description?: string;
  subcommands?: ManifestCommand[];
  options?: ManifestOption[];
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

  if (cmd.options.length > 0) {
    node.options = cmd.options.map((o) => {
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

/**
 * Locate a manifest node by dotted command-ID path (e.g., "tasks.dispatch"
 * → manifest.subcommands["tasks"].subcommands["dispatch"]). Returns undefined
 * if any segment doesn't match (the command may be lazy-loaded but not yet
 * wired into the Commander tree, or it may be hidden).
 */
function findNodeByCommandId(
  root: ManifestCommand,
  commandId: string
): ManifestCommand | undefined {
  const segments = commandId.split(".");
  let cur: ManifestCommand | undefined = root;
  for (const seg of segments) {
    if (!cur?.subcommands) return undefined;
    cur = cur.subcommands.find((s) => s.name === seg);
    if (!cur) return undefined;
  }
  return cur;
}

async function main() {
  const container = await createCliContainer();
  try {
    const cli = await createCli(container);

    // Pass 1: structural walk of the Commander tree.
    const manifest = walkCommand(cli);

    // Pass 2: enrich with Zod-derived enum values from the shared registry.
    let valuesInjected = 0;
    let valuesAttempted = 0;
    for (const cmd of sharedCommandRegistry.getAllCommands()) {
      const node = findNodeByCommandId(manifest, cmd.id);
      if (!node) continue; // command not in the visible Commander tree
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
    writeFileSync(outPath, `${JSON.stringify(wrapped, null, 2)}\n`);

    console.log(
      `Wrote completion manifest: ${outPath}\n` +
        `  Enum-value injections: ${valuesInjected}/${valuesAttempted} (` +
        `${valuesAttempted - valuesInjected} options not found in Commander tree)`
    );
  } finally {
    await container.close();
  }
}

await main();
