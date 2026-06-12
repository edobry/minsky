#!/usr/bin/env bun
/**
 * Smoke: reviewer-image module resolution (mt#2453).
 *
 * The reviewer Docker image copies `packages/shared/src`, `packages/domain/src`,
 * and `services/reviewer/src` — NOT the monorepo root `src/` tree. Any relative
 * import in those packages that escapes into root `src/` resolves fine on a dev
 * checkout (full repo present) but crashes the container at boot:
 *
 *   ResolveMessage: Cannot find module '../../../../src/utils/safe-truncate.ts'
 *   from '/app/packages/domain/src/persistence/postgres-retry.ts'
 *
 * This script reproduces the image layout in a temp dir (same COPY set as
 * services/reviewer/Dockerfile) and runs `bun build --packages=external` over
 * the boot entry points. `--packages=external` skips bare (node_modules)
 * specifiers but traverses every RELATIVE import — statically or via literal
 * dynamic import — so any package-boundary escape reachable from the boot path
 * fails resolution here exactly as it would in the deployed container.
 *
 * Entry points checked:
 *  - packages/domain/src/composition/domain.ts (createDomainContainer — the
 *    bootDomainContainer() target; its factory dynamic-imports are literal
 *    specifiers, so bun's bundler traverses them)
 *  - services/reviewer/src/server.ts (the container's CMD entry)
 *
 * Exit 0 = all boot-reachable relative imports resolve within the image COPY
 * set. Non-zero = at least one escape; the bun build error names the offending
 * specifier and importer.
 *
 * No env vars, network, or DB required.
 */

import { mkdtempSync, rmSync, cpSync, mkdirSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const stage = mkdtempSync(join(tmpdir(), "mt2453-image-layout-"));

// Mirror services/reviewer/Dockerfile's source COPY set.
const copies: Array<[string, string]> = [
  ["package.json", "package.json"],
  ["packages/shared/src", "packages/shared/src"],
  ["packages/shared/package.json", "packages/shared/package.json"],
  ["packages/shared/tsconfig.json", "packages/shared/tsconfig.json"],
  ["packages/domain/src", "packages/domain/src"],
  ["packages/domain/package.json", "packages/domain/package.json"],
  ["packages/domain/tsconfig.json", "packages/domain/tsconfig.json"],
  ["services/reviewer/src", "services/reviewer/src"],
  ["services/reviewer/package.json", "services/reviewer/package.json"],
  ["services/reviewer/tsconfig.json", "services/reviewer/tsconfig.json"],
];

const entryPoints = [
  "packages/domain/src/composition/domain.ts",
  "services/reviewer/src/server.ts",
];

interface EntryResult {
  entry: string;
  ok: boolean;
  stderr: string;
  stdout: string;
}

try {
  for (const [src, dest] of copies) {
    cpSync(join(repoRoot, src), join(stage, dest), { recursive: true });
  }

  // The workspace install would symlink @minsky/* into node_modules; recreate
  // just those links so relative resolution INTO the packages works for any
  // future intra-workspace bare imports. Third-party bare specifiers stay
  // unresolved by design (--packages=external).
  mkdirSync(join(stage, "node_modules", "@minsky"), { recursive: true });
  symlinkSync(join(stage, "packages", "shared"), join(stage, "node_modules", "@minsky", "shared"));
  symlinkSync(join(stage, "packages", "domain"), join(stage, "node_modules", "@minsky", "domain"));

  const results: EntryResult[] = entryPoints.map((entry) => {
    const proc = spawnSync(
      "bun",
      [
        "build",
        join(stage, entry),
        "--target=bun",
        "--packages=external",
        "--outdir",
        join(stage, ".smoke-out"),
      ],
      { cwd: stage, encoding: "utf8", timeout: 120_000 }
    );
    return { entry, ok: proc.status === 0, stderr: proc.stderr ?? "", stdout: proc.stdout ?? "" };
  });

  const failures = results.filter((r) => !r.ok);
  console.log(
    JSON.stringify(
      {
        check: "reviewer-image-module-resolution",
        task: "mt#2453",
        entries: results.map(({ entry, ok }) => ({ entry, ok })),
        pass: failures.length === 0,
      },
      null,
      2
    )
  );

  if (failures.length > 0) {
    for (const f of failures) {
      console.error(`\n--- ${f.entry} ---\n${f.stderr}${f.stdout}`);
    }
    // Set exitCode rather than calling process.exit() so the finally block
    // below still runs and the temp dir is cleaned up on failure.
    process.exitCode = 1;
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
}
