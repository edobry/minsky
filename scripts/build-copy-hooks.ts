#!/usr/bin/env bun
/**
 * Emit the observability-baseline hook sources next to the bundle (mt#3578).
 *
 * `resolveHookSourceDir()` (packages/domain/src/setup/hook-provisioning.ts,
 * mt#3499) resolves hook sources with an ordered candidate list whose first
 * entry is `./hooks` beside the compiled module — i.e. `dist/hooks/` for a
 * `dist/minsky.js` bundle run. Until this script existed, nothing emitted that
 * directory: provisioning worked only because the dev checkout IS the install
 * (the resolver's second, dev-layout candidate). This is the hooks analog of
 * `build:copy-migrations` (mt#1767 Phase 0 triad: bundler-emits-assets +
 * resolver + cold-start test).
 *
 * The file list is imported from the provisioning module itself — the single
 * source of truth — rather than duplicated here, so adding a hook to the
 * baseline automatically ships it. Sources are copied from `.claude/hooks/`
 * (the COMPILED output of `.minsky/hooks/`, which is what provisioning
 * installs), not from the `.minsky` sources.
 *
 * Exit codes: 0 on success; 1 if any baseline file is missing (fail loud —
 * a silent skip would reproduce the invisible-project bug mt#3499 fixed).
 */

import { copyFileSync, existsSync, mkdirSync, chmodSync } from "fs";
import { join } from "path";
import { BASELINE_INSTALL_FILES } from "../packages/domain/src/setup/hook-provisioning";

const repoRoot = import.meta.dir.replace(/\/scripts$/, "");
const sourceDir = join(repoRoot, ".claude", "hooks");
const outDir = join(repoRoot, "dist", "hooks");

mkdirSync(outDir, { recursive: true });

let failed = false;
for (const fileName of BASELINE_INSTALL_FILES) {
  const from = join(sourceDir, fileName);
  const to = join(outDir, fileName);
  if (!existsSync(from)) {
    console.error(`ERROR: baseline hook source missing: ${from}`);
    failed = true;
    continue;
  }
  copyFileSync(from, to);
  // Hooks carry a `#!/usr/bin/env bun` shebang and are invoked by path — the
  // executable bit is load-bearing (mirrors provisionObservabilityHooks).
  chmodSync(to, 0o755);
  console.log(`copied ${fileName} -> dist/hooks/`);
}

if (failed) {
  console.error(
    `Baseline hook emission failed. Expected every BASELINE_INSTALL_FILES entry under ${sourceDir}.`
  );
  process.exit(1);
}
