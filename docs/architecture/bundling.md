# Bundling architecture (mt#1740)

The Minsky CLI ships as **two artifacts** plus an orthogonal supervision layer.
This document describes how the bundle is built, when it's regenerated, and how
the four deployment profiles (A–D) consume it.

## Two artifacts

1. **`scripts/cli-entry.ts`** — the **bin entry**, ~50 LOC. What `package.json`
   `"bin"` resolves to. Does freshness detection + (rebuild) + import.
2. **`dist/minsky.js`** — the **bundle**. Produced by:

   ```sh
   bun build --target=bun --outfile=dist/minsky.js src/cli.ts
   ```

   Single-file pre-parsed JavaScript output. The actual MCP server, CLI commands,
   tool registry, etc. all live inside.

The bin entry uses `await import(bundlePath)` — not subprocess spawn. The bin
entry's Bun process **becomes** the bundle's runtime. There is no extra fork,
no double Bun-startup, no IPC. The bin entry is just the first ~50 lines of
execution before the bundle takes over.

## When the bundle gets built

| Trigger                                                 | Profile              | Mechanism                                                                |
| ------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------ |
| `git rev-parse HEAD` differs from `dist/.build-stamp`   | A (source install)   | Bin entry runs `bun build` synchronously at startup                      |
| Docker image build                                      | B (Railway HTTP)     | `RUN bun build ...` step in `Dockerfile`                                 |
| Future `bun install -g minsky` from a published package | D (end-user install) | `prepublishOnly` script ran at publish time; bundle ships in the tarball |
| Manual `bun run build`                                  | Any                  | Convenience for dev work outside the bin-entry path                      |

The bin entry only rebuilds when source has actually changed; the HEAD-sentinel
check is ~10ms. Subsequent `/mcp` reconnects on the same HEAD reuse the existing
bundle.

## How the bin entry decides what to exec

```ts
const isSourceInstall = fs.existsSync(packageRoot + "/src/cli.ts");

if (isSourceInstall) {
  // Profile A / C: check freshness, rebuild if stale
  if (git_head !== stamp_content) bun_build();
}

if (existsSync(bundlePath)) {
  await import(bundlePath); // fast path
} else {
  await import(sourcePath); // fallback: fresh clone, build failed, etc.
}
```

The realpath-based detection (resolving symlinks via `realpathSync(fileURLToPath(import.meta.url))`)
correctly distinguishes three install shapes:

| Install shape                                  | `realpath` resolves to                   | `src/cli.ts` exists?                       | Verdict           |
| ---------------------------------------------- | ---------------------------------------- | ------------------------------------------ | ----------------- |
| Direct exec from source repo                   | `~/Projects/minsky/scripts/cli-entry.ts` | Yes                                        | Source install    |
| `bun link` symlink (today's global install)    | Source path (follows symlink)            | Yes                                        | Source install    |
| `bun install -g minsky` from published package | Install path (no source)                 | No (excluded via `package.json` `"files"`) | Published install |

## Deployment profiles

### Profile A — Local stdio (Claude Code-managed, current default)

- Claude Code spawns `minsky mcp start` per session
- `package.json` `"bin"` → `./scripts/cli-entry.ts`
- Bin entry: realpath → source install detected → check HEAD-sentinel → rebuild if stale → `await import(dist/minsky.js)`
- Combined with mt#1714's stdio proxy: the proxy spawns `minsky mcp start` as a child; the bin entry runs inside that child, transparent to the proxy

### Profile B — Railway HTTP (deployed, immutable container)

- Dockerfile bypasses the bin entry entirely
- `RUN bun build --target=bun --outfile=dist/minsky.js src/cli.ts` at image-build time
- `CMD bun run dist/minsky.js mcp start --http ...` execs the bundle directly
- No freshness check needed — the image is immutable; the bundle is fresh by definition

### Profile C — Future local HTTP daemon (mt#1713)

- User runs the daemon as a separately-managed service
- Same `package.json` `"bin"` entry; same bin entry logic
- Daemon is long-lived; freshness check only fires when the daemon restarts (manually OR via mt#1713's supervisor catching staleness exit and respawning)

### Profile D — Future end-user install (`bun install -g minsky` from npm)

- `prepublishOnly` script builds the bundle at publish time
- `package.json` `"files": ["dist/", "scripts/cli-entry.ts", ...]` ensures `src/` is NOT in the tarball
- Bin entry detects "no source available" → skips rebuild path → directly imports the bundle
- User sees fast first-invocation; no Bun-runtime dependency at install time (bundle is parseable by Bun)

## Supervision is orthogonal

Process supervision (catch exits, respawn on staleness) lives at a different
layer than the bin entry. It's not "between" the bin entry and the bundle —
it sits **above**:

```
Claude Code / HTTP client
    ↓ stable connection
SUPERVISOR (mt#1714 stdio proxy / mt#1713 HTTP daemon)
    ↓ spawns `minsky mcp start` (or daemon equivalent)
BIN ENTRY (scripts/cli-entry.ts)
    ↓ freshness check, then await import()
BUNDLE (dist/minsky.js) — same Bun process as bin entry
```

The supervisor doesn't know about freshness, build-stamps, or bundles. It just
spawns its child. Whether the child execs source or bundle, or has a freshness
preamble, is invisible to the supervisor.

## Concurrency analysis

The bin entry implements a check-then-act pattern (check freshness → maybe
rebuild → exec). Three TOCTOU windows, all accepted as idempotent:

1. **Read atomicity** — `git rev-parse HEAD` + read `dist/.build-stamp`. Worst
   case if HEAD moves between reads: rebuild we didn't need, or skip rebuild
   we should have done. Skip case self-corrects on next invocation.
2. **Decision-action gap** — between freshness decision and `bun build`, source
   could be edited. `bun build` reads source at build time; concurrent edits
   resolve to either old-or-new build, both valid.
3. **Stale-read** — `dist/.build-stamp` is the last-built HEAD. Staleness is
   exactly what we're testing for; this is by design.

All three: idempotent. No mitigation; documented at the freshness-check site.

## Performance target

Profile A cold-start on warm filesystem cache:

- Before (raw source parse): ~2000-4000ms per `/mcp` reconnect
- After (bundle): target ≤750ms (≥4× speedup)

Measured via `scripts/measure-cold-start.ts`; results in
`scripts/cold-start-results.json`. Run from main-agent context after PR
creation; redacted results appended to PR body `## Live verification` section.

## Future: bun build --compile (mt#1729)

Bun has a `--compile` flag that produces a standalone executable (no Bun runtime
dependency at exec time). Compatibility with mt#1719's dynamic-import lazy-load
shape is under investigation in **mt#1729**. If `--compile` survives the
investigation, the bin entry's exec path becomes `dist/minsky` (binary) instead
of `bun run dist/minsky.js`. Profile D especially benefits — end users wouldn't
need Bun installed.

Known [Bun issue #13405](https://github.com/oven-sh/bun/issues/13405): under
`--compile`, `import.meta.url` resolves cwd-relative rather than file-relative,
which would break the realpath-based source-vs-published detection. mt#1729
evaluates workarounds (Profile D uses `--compile` while Profile A/C stay on
non-compile bundle is one option).

## Cross-references

- **mt#1720** — RFC that scoped this work
- **mt#1740** — implementation task (this doc)
- **mt#1719** — lazy tool registration (complementary; reduces handler-tree parse cost)
- **mt#1714** — stdio proxy (supervision layer for Profile A)
- **mt#1713** — future HTTP daemon (supervision layer for Profile C)
- **mt#1729** — `--compile` investigation
- **mt#1705** — disconnect classification (measurement layer that motivated this perf work)
