#!/usr/bin/env bun
/**
 * Build the shell-completion manifest by force-loading the full CLI command
 * tree and walking it. The output is a static JSON consumed by the
 * `completions complete` handler at TAB time.
 *
 * Why a static manifest (not live tree-walking at completion time):
 * lazy-loaded heavy commands cost ~700ms to import; that blows the 300ms
 * completion-latency budget. The manifest is generated once at build time
 * and read in <10ms at completion time. See mt#1892 §D1.
 *
 * Trigger: `bun run scripts/build-completion-manifest.ts` (also wired into
 * `bun run build` via the `build:completion-manifest` script in package.json).
 */
import "reflect-metadata";
import { writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import type { Command } from "commander";

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

interface ManifestOption {
  /** All flag forms for this option, e.g. ["-b", "--backend"]. */
  flags: string[];
  description?: string;
}

interface ManifestCommand {
  name: string;
  description?: string;
  subcommands?: ManifestCommand[];
  options?: ManifestOption[];
}

function walkCommand(cmd: Command): ManifestCommand {
  const node: ManifestCommand = { name: cmd.name() };
  const desc = cmd.description();
  if (desc) node.description = desc;

  // Hidden subcommands (e.g., the `completions complete` handler once it
  // exists) are included in v1 — Commander 14 has no public reader for the
  // hidden flag and accessing the private field violates lint rules. The
  // cosmetic cost is that `minsky completions <TAB>` will include `complete`
  // alongside the user-facing verbs. Acceptable for v1; filter can be added
  // later if it becomes a problem.
  if (cmd.commands.length > 0) {
    node.subcommands = cmd.commands.map(walkCommand);
  }

  if (cmd.options.length > 0) {
    node.options = cmd.options.map((o) => {
      const flags: string[] = [];
      if (o.short) flags.push(o.short);
      if (o.long) flags.push(o.long);
      const opt: ManifestOption = { flags };
      if (o.description) opt.description = o.description;
      return opt;
    });
  }

  return node;
}

async function main() {
  const container = await createCliContainer();
  try {
    const cli = await createCli(container);
    const manifest = walkCommand(cli);

    // Add a generation-banner marker so the generated-file-edit guard hook
    // catches direct edits to this file (per CLAUDE.md Generated File Edit Guard).
    const wrapped = {
      _generated: "by scripts/build-completion-manifest.ts — do not edit directly",
      ...manifest,
    };

    const outPath = join(import.meta.dir, "..", "src", "generated", "completion-manifest.json");
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(wrapped, null, 2)}\n`);

    console.log(`Wrote completion manifest: ${outPath}`);
  } finally {
    await container.close();
  }
}

await main();
