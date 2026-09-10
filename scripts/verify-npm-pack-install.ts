#!/usr/bin/env bun
/**
 * Prepublish pack-and-install smoke (mt#3949).
 *
 * Answers the one question every publisher-side check leaves open: **can anyone actually
 * install this?**
 *
 * `@edobry/minsky@0.1.1` was published, name-owned, OIDC-authenticated and provenance-signed,
 * and could not be installed by anybody — its manifest declared two dependencies at
 * `workspace:*`, which no registry client can resolve. Every gate the publish path had was a
 * publisher-side gate, and all of them pass on an uninstallable package. This script is the
 * consumer-side one.
 *
 * It runs against a `npm pack` artifact, which is byte-identical to what `npm publish` would
 * upload, so it fails BEFORE a version number is burned. Verifying by publishing and then
 * installing is how the defect was created; it costs an immutable version per attempt.
 *
 * What it exercises, in the order a user would hit it:
 *   1. `npm pack`                      — produce the exact publishable artifact
 *   2. the packed manifest             — no local-only protocol specs survived into it
 *   3. `bun add <tarball>`             — local install, in a scratch dir outside the repo
 *   4. `minsky --version`              — the installed bin actually runs
 *   4b. `minsky persistence migrate`   — migrations apply from the INSTALLED layout (mt#3887)
 *   5. `bun add -g <tarball>`          — the global install path, the documented channel
 *   6. `minsky --version` (global)     — the global bin actually runs
 *
 * The global install is directed at a throwaway `BUN_INSTALL` prefix, NEVER the caller's real
 * `~/.bun`. A developer's `minsky` on PATH is typically a symlink into their source install,
 * and their MCP server runs through it — a real `bun add -g` would overwrite it mid-session.
 * The prefix is the only substitution: same bun, same global code path, same bin linking.
 *
 * Step 4b (mt#3887) is the FALSIFIER for excluding `dist/storage/migrations/pg/meta/*_snapshot.json`
 * from `files[]`: those files are drizzle-kit's migration-AUTHORING metadata (used to diff schema
 * state when GENERATING the next migration), and the claim that `migrate --execute` never reads
 * them rests on drizzle's documented generate-time/apply-time split — a claim to be falsified by
 * running it, not by reading docs. This step packs+installs (the exact tarball this script already
 * produces, which no longer carries the snapshots) and applies migrations against a real Postgres
 * from OUTSIDE the repo, mirroring `scripts/smoke-cold-start-migrate.ts`'s pattern but against the
 * INSTALLED package rather than `dist/` in-repo. Env-gated on `DATABASE_URL` — skipped (not failed)
 * when absent, since a throwaway Postgres is not always available locally. If migrations FAIL here,
 * the premise is wrong and the snapshot exclusion must be reverted — this step existing as a gate is
 * what keeps that reversal from being discovered by a broken published package instead.
 *
 * Requires network access (the tarball's ~577 transitive dependencies resolve from the
 * registry). Set MINSKY_SKIP_PACK_INSTALL_SMOKE=1 to skip with exit 0.
 *
 * Usage: bun scripts/verify-npm-pack-install.ts
 *        DATABASE_URL=postgres://... bun scripts/verify-npm-pack-install.ts   # also runs step 4b
 * Exit:  0 = pass or skipped, non-zero = fail. Structured summary on stdout.
 */

import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/** Dependency-spec prefixes that resolve locally and cannot resolve from a registry. */
const LOCAL_ONLY_PROTOCOLS = ["workspace:", "file:", "link:"];

/** Generous enough for a cold dependency resolution on a slow runner. */
const STEP_TIMEOUT_MS = 300_000;

const repoRoot = join(import.meta.dir, "..");

interface StepResult {
  step: string;
  ok: boolean;
  detail: string;
}

const results: StepResult[] = [];

function record(step: string, ok: boolean, detail: string): boolean {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

function run(
  command: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string> }
): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd: opts.cwd,
    encoding: "utf8",
    timeout: STEP_TIMEOUT_MS,
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** The CLI's own output is the LAST stdout line — an install may print progress ahead of it. */
function lastLine(text: string): string {
  const lines = text.trim().split("\n");
  return (lines[lines.length - 1] ?? "").trim();
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+/;

if (process.env.MINSKY_SKIP_PACK_INSTALL_SMOKE === "1") {
  console.log("SKIP: MINSKY_SKIP_PACK_INSTALL_SMOKE=1");
  process.exit(0);
}

const workDir = mkdtempSync(join(tmpdir(), "minsky-pack-smoke-"));

try {
  // ── 1. Pack ────────────────────────────────────────────────────────────────
  // `bun run build` is NOT invoked here: the bundle is a separate concern with its own gate
  // (bundle-boot-smoke), and a stale-bundle failure should read as a stale bundle, not as an
  // install failure. Fail early and say so instead.
  if (!existsSync(join(repoRoot, "dist", "minsky.js"))) {
    record("prerequisite", false, "dist/minsky.js missing — run `bun run build` first");
    throw new Error("bundle missing");
  }

  const pack = run("npm", ["pack", "--pack-destination", workDir], { cwd: repoRoot });
  if (!pack.ok) {
    record("npm pack", false, pack.stderr.trim().split("\n").slice(-3).join(" | "));
    throw new Error("pack failed");
  }
  const tarballName = lastLine(pack.stdout);
  const tarballPath = join(workDir, tarballName);
  if (!existsSync(tarballPath)) {
    record("npm pack", false, `expected tarball at ${tarballPath}`);
    throw new Error("tarball missing");
  }
  record("npm pack", true, tarballName);

  // ── 2. The packed manifest is registry-resolvable ──────────────────────────
  // The static test in tests/scripts/publish-manifest.test.ts asserts this over the SOURCE
  // manifest. This asserts it over the PACKED one — the artifact that actually ships, after
  // whatever prepack/files processing npm applies.
  const extracted = run("tar", ["-xzOf", tarballPath, "package/package.json"], { cwd: workDir });
  if (!extracted.ok) {
    record("packed manifest readable", false, extracted.stderr.trim());
    throw new Error("could not read packed manifest");
  }
  const packedManifest = JSON.parse(extracted.stdout) as {
    dependencies?: Record<string, string>;
  };
  const localOnly = Object.entries(packedManifest.dependencies ?? {}).filter(([, spec]) =>
    LOCAL_ONLY_PROTOCOLS.some((protocol) => spec.startsWith(protocol))
  );
  if (
    !record(
      "packed manifest has no local-only protocol deps",
      localOnly.length === 0,
      localOnly.length === 0
        ? "0 offenders"
        : localOnly.map(([name, spec]) => `${name}@${spec}`).join(", ")
    )
  ) {
    throw new Error("packed manifest is not registry-resolvable");
  }

  // ── 3-4. Local install, then run the installed bin ─────────────────────────
  const localDir = join(workDir, "local");
  const consumerManifest = { name: "pack-smoke-consumer", version: "1.0.0", private: true };
  run("mkdir", ["-p", localDir], { cwd: workDir });
  writeFileSync(join(localDir, "package.json"), `${JSON.stringify(consumerManifest, null, 2)}\n`);

  const localAdd = run("bun", ["add", tarballPath], { cwd: localDir });
  if (
    !record("bun add <tarball>", localAdd.ok, localAdd.ok ? "installed" : lastLine(localAdd.stderr))
  ) {
    throw new Error("local install failed");
  }

  const localBin = join(localDir, "node_modules", ".bin", "minsky");
  const localRun = run(localBin, ["--version"], { cwd: localDir });
  const localVersion = lastLine(localRun.stdout);
  if (
    !record(
      "installed bin prints a version",
      localRun.ok && VERSION_PATTERN.test(localVersion),
      localRun.ok ? localVersion || "(no output)" : lastLine(localRun.stderr)
    )
  ) {
    throw new Error("installed bin did not print a version");
  }

  // ── 4a. The bin runs the command a new user runs FIRST (mt#5063) ────────────
  //
  // `--version` is not a sufficient smoke: it returns before the command tree is
  // built, so it never touches the tokenizer. The published 0.2.0 passed this
  // whole job while `minsky --help` exited 1 with `Missing tiktoken_bg.wasm` for
  // every user — the bundler had baked the CI runner's `__dirname` into
  // tiktoken's wasm lookup.
  //
  // `--help` costs one more spawn and traverses the full command tree, which is
  // what makes it able to fail. This is the assertion whose absence let a broken
  // first command ship past a green pack-install check.
  const localHelp = run(localBin, ["--help"], { cwd: localDir });
  if (
    !record(
      "installed bin runs --help (the first command a new user runs)",
      localHelp.ok && localHelp.stdout.includes("Usage:"),
      localHelp.ok ? lastLine(localHelp.stdout) || "(no output)" : lastLine(localHelp.stderr)
    )
  ) {
    throw new Error("installed bin could not run --help");
  }

  // ── 4b. The TOKENIZER resolves and works from the installed package (mt#5063 SC3) ─
  //
  // `--help` proves the tokenizer no longer breaks BOOT; it does not prove the
  // tokenizer WORKS, because mt#5063 externalised it and `--help` never reaches
  // it. Those are opposite failure modes and one check cannot cover both: an
  // `--external` package that is not installed fails at the point of USE, which
  // is silent until something tokenizes.
  //
  // So exercise the dependency the way a real consumer does — resolve it from
  // the installed tree and actually encode. Written to a file and run with
  // `bun`, so it exercises MODULE RESOLUTION from `localDir` rather than this
  // script's own.
  const tokenizerProbe = join(localDir, "verify-tokenizer.ts");
  writeFileSync(
    tokenizerProbe,
    [
      "const { get_encoding } = await import('tiktoken');",
      "const enc = get_encoding('cl100k_base');",
      "const n = enc.encode('hello world').length;",
      "enc.free();",
      "if (n < 1) throw new Error('tokenizer returned no tokens');",
      "console.log('tokens=' + n);",
    ].join("\n"),
    "utf8"
  );
  const tokenizerRun = run("bun", [tokenizerProbe], { cwd: localDir });
  if (
    !record(
      "tokenizer resolves and encodes from the installed package",
      tokenizerRun.ok && /tokens=\d+/.test(tokenizerRun.stdout),
      tokenizerRun.ok
        ? lastLine(tokenizerRun.stdout) || "(no output)"
        : lastLine(tokenizerRun.stderr)
    )
  ) {
    throw new Error("tokenizer did not resolve from the installed package");
  }

  // ── 4c. typescript resolves from the installed package (mt#5067) ────────────
  //
  // Same shape as 4b, for the second externalised package. typescript is a
  // DECLARED peer (`peerDependencies.typescript: 5.8.3`), which bun and npm≥7
  // auto-install — but "declared" is a manifest claim, and this is the run that
  // checks it against the tree a consumer actually gets. If typescript ever
  // stops arriving alongside the package, `--external typescript` turns into a
  // point-of-use failure inside `context generate --components error-context`
  // instead of a build-time one, and this is the only check that would see it.
  //
  // `getDefaultLibFilePath` is asserted too: it walks from typescript's OWN
  // `__filename`, which is the lookup the bundled copy pinned to the build host.
  // Resolved from the consumer's tree it must point at a lib file that exists.
  const typescriptProbe = join(localDir, "verify-typescript.ts");
  writeFileSync(
    typescriptProbe,
    [
      "const ts = await import('typescript');",
      "const { existsSync } = await import('fs');",
      "const lib = ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES2020 });",
      "if (!existsSync(lib)) throw new Error('default lib not found at ' + lib);",
      "console.log('typescript=' + ts.version + ' lib=' + lib);",
    ].join("\n"),
    "utf8"
  );
  const typescriptRun = run("bun", [typescriptProbe], { cwd: localDir });
  if (
    !record(
      "typescript resolves from the installed package, with its lib files",
      typescriptRun.ok && /typescript=\d+\.\d+\.\d+ lib=/.test(typescriptRun.stdout),
      typescriptRun.ok
        ? lastLine(typescriptRun.stdout) || "(no output)"
        : lastLine(typescriptRun.stderr)
    )
  ) {
    throw new Error("typescript did not resolve from the installed package");
  }

  // ── 4b. Apply migrations against a real Postgres, from the INSTALLED layout ─
  // (mt#3887) Falsifies the `meta/*_snapshot.json` exclusion by running, not by reading
  // drizzle's docs. Env-gated: a throwaway Postgres isn't always available locally, so this
  // step SKIPS (not fails) when DATABASE_URL is unset, mirroring
  // scripts/smoke-cold-start-migrate.ts's convention.
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    record(
      "migrations apply from installed package",
      true,
      "SKIP — DATABASE_URL not set (set it to also run this falsifier)"
    );
  } else {
    const migrateResult = run(localBin, ["persistence", "migrate", "--execute"], {
      cwd: localDir,
      env: {
        MINSKY_PERSISTENCE_BACKEND: "postgres",
        MINSKY_PERSISTENCE_POSTGRES_URL: databaseUrl,
      },
    });
    if (
      !record(
        "migrations apply from installed package",
        migrateResult.ok,
        migrateResult.ok
          ? "migrate --execute exited 0"
          : migrateResult.stderr.trim().split("\n").slice(-5).join(" | ")
      )
    ) {
      throw new Error(
        "migrations did not apply from the installed (snapshot-excluded) package — the " +
          "meta/*_snapshot.json exclusion premise is FALSE and must be reverted in package.json"
      );
    }

    // Belt-and-suspenders: confirm the dry-run reports 0 pending, same discipline as
    // smoke-cold-start-migrate.ts step 3 — an exit-0 without this could mean the resolver
    // found an empty/wrong folder rather than actually applying anything.
    const dryRun = run(localBin, ["persistence", "migrate"], {
      cwd: localDir,
      env: {
        MINSKY_PERSISTENCE_BACKEND: "postgres",
        MINSKY_PERSISTENCE_POSTGRES_URL: databaseUrl,
      },
    });
    const reportsZeroPending = dryRun.ok && dryRun.stdout.includes("0 pending");
    if (
      !record(
        "dry-run confirms 0 pending after execute",
        reportsZeroPending,
        reportsZeroPending ? "0 pending" : lastLine(dryRun.stdout || dryRun.stderr)
      )
    ) {
      throw new Error("dry-run did not report 0 pending after --execute");
    }
  }

  // ── 5-6. Global install into a THROWAWAY prefix, then run the global bin ───
  const globalPrefix = join(workDir, "globalprefix");
  run("mkdir", ["-p", globalPrefix], { cwd: workDir });

  const globalAdd = run("bun", ["add", "-g", tarballPath], {
    cwd: workDir,
    env: { BUN_INSTALL: globalPrefix },
  });
  if (
    !record(
      "bun add -g <tarball>",
      globalAdd.ok,
      globalAdd.ok ? "installed" : lastLine(globalAdd.stderr)
    )
  ) {
    throw new Error("global install failed");
  }

  const globalBin = join(globalPrefix, "bin", "minsky");
  const globalRun = run(globalBin, ["--version"], { cwd: workDir });
  const globalVersion = lastLine(globalRun.stdout);
  if (
    !record(
      "global bin prints a version",
      globalRun.ok && VERSION_PATTERN.test(globalVersion),
      globalRun.ok ? globalVersion || "(no output)" : lastLine(globalRun.stderr)
    )
  ) {
    throw new Error("global bin did not print a version");
  }
} catch (error) {
  console.log(
    JSON.stringify(
      { ok: false, error: error instanceof Error ? error.message : String(error), results },
      null,
      2
    )
  );
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, results }, null, 2));
rmSync(workDir, { recursive: true, force: true });
process.exit(0);
