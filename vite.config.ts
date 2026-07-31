// Bare "child_process", not "node:child_process" — see resolveBuildCommit below
// for why this is not Bun.spawnSync. The lint rule bans only the node:-prefixed
// specifier, so this form needs no disable directive.
import { execSync } from "child_process";
import { defineConfig } from "vite";
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

export default defineConfig({
  root: "src/cockpit/web",
  plugins: [react()],
  define: {
    __BUILD_COMMIT__: JSON.stringify(resolveBuildCommit()),
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
