// Bare "child_process", not "node:child_process" — see resolveBuildCommit below
// for why this is not Bun.spawnSync. The lint rule bans only the node:-prefixed
// specifier, so this form needs no disable directive.
import { execSync } from "child_process";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The commit this BUNDLE was built from (mt#3241).
 *
 * The web bundle and the cockpit daemon are versioned INDEPENDENTLY: the tray's
 * web watcher (mt#2297) rebuilds `dist/` on change without restarting the
 * daemon, so what a reader is looking at can be many commits newer than the
 * process serving it. `/api/health`'s `commit` names the DAEMON's provenance and
 * cannot answer for the bundle, so the bundle carries its own.
 *
 * Resolved here, at build time, because that is the only moment the answer
 * exists — the running bundle has no access to git. Falls back to `"unknown"`
 * when git is unavailable or the tree is not a repo, mirroring `getGitCommit` in
 * `src/cockpit/routes/health.ts`: a Docker build or a non-git checkout must
 * degrade, never fail the build.
 *
 * **Why `execSync` and not `Bun.spawnSync`, despite `bun_over_node.mdc`.** `Bun`
 * is not defined when vite evaluates this config — measured: the Bun form threw,
 * the `catch` swallowed it, and every build silently baked in `"unknown"` while
 * still exiting 0 with clean lint. Matches `src/cockpit/routes/health.ts:22`.
 *
 * If a future change makes `Bun` available here, switching back is fine — but
 * verify by grepping `dist/assets/*.js` for the actual sha. A green build proves
 * nothing about this line, because the fallback is silent by design.
 *
 * `stdio: "pipe"` keeps `fatal: not a git repository` out of the build output.
 */
function resolveBuildCommit(): string {
  try {
    const sha = String(
      execSync("git rev-parse --short HEAD", { encoding: "utf-8", stdio: "pipe" })
    ).trim();
    return sha.length > 0 ? sha : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * The bundle's identity, resolved ONCE per build (mt#5034).
 *
 * Both consumers below read this same constant: the `__BUILD_COMMIT__` define
 * that `RailFooter` renders, and the `build-info.json` sidecar that
 * `/api/health` reports. Calling `resolveBuildCommit()` twice would let the
 * footer and the health payload disagree if HEAD moved mid-build — a drift with
 * no symptom until someone compares them.
 */
const BUILD_COMMIT = resolveBuildCommit();

/**
 * Emit `build-info.json` beside the bundle so the SERVER can read the bundle's
 * identity (mt#5034).
 *
 * **Why a sidecar at all.** `__BUILD_COMMIT__` is a compile-time text
 * substitution into the emitted JS, so it exists only inside the bundle. The
 * cockpit daemon serves that bundle statically and cannot read a value baked
 * into it — which is why `/api/health` could report the DAEMON's commit while
 * serving a much newer bundle, and a shipped web change read as undeployed. The
 * tray's web watcher (mt#2297) rebuilds `dist/` WITHOUT restarting the daemon,
 * so the two identities genuinely diverge by design.
 *
 * **Why `generateBundle` + `this.emitFile`, not `closeBundle` + `fs.write`.**
 * Rollup documents `this.emitFile` inside `generateBundle` as the mechanism for
 * emitting an additional file, and describes `closeBundle` as a cleanup hook
 * whose invocation "is the responsibility of users of the JavaScript API to
 * manually call `bundle.close()`". A `closeBundle` that does not fire would
 * leave a STALE `build-info.json` — the same stale-identity defect this exists
 * to remove, in a form that is harder to catch, because the field would be
 * present and look authoritative rather than obviously naming the wrong commit.
 *
 * @param nowMs Injected clock (`testing-standards.mdc`); real default.
 */
function emitBuildInfo(nowMs: number = Date.now()): Plugin {
  return {
    name: "minsky-cockpit-build-info",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "build-info.json",
        source: `${JSON.stringify(
          { commit: BUILD_COMMIT, builtAt: new Date(nowMs).toISOString() },
          null,
          2
        )}\n`,
      });
    },
  };
}

export default defineConfig({
  root: "src/cockpit/web",
  plugins: [react(), emitBuildInfo()],
  define: {
    __BUILD_COMMIT__: JSON.stringify(BUILD_COMMIT),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Long-cached vendor chunks. Page chunks are produced automatically from
    // React.lazy() dynamic imports in App.tsx; this manualChunks map only
    // governs the shared vendor split. Keep this list tight — over-splitting
    // adds HTTP request overhead without proportional cache benefit.
    rollupOptions: {
      output: {
        manualChunks: {
          "react-vendor": ["react", "react-dom"],
          router: ["react-router-dom"],
          tanstack: ["@tanstack/react-query"],
          icons: ["lucide-react"],
          // Markdown rendering (mt#2550): react-markdown + remark/rehype/unified
          // toolchain. Isolated so the ~60-80KB gz pipeline is a long-cached chunk
          // loaded only on pages that render prose.
          markdown: ["react-markdown", "remark-gfm"],
        },
      },
    },
  },
  server: { proxy: { "/api": "http://localhost:3737" } },
});
