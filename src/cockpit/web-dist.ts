import path from "path";

/**
 * Bundle-aware resolution of the cockpit web-dist directory (mt#2283).
 *
 * `bun run cockpit:build` writes the SPA to `<repo>/src/cockpit/web/dist`.
 * Computing this path via `import.meta.url` breaks when the CLI runs from the
 * bundled `dist/minsky.js`: `import.meta.url` points into `<repo>/dist`, so the
 * old `path.join(__dirname, "..", "..", "cockpit", "web", "dist")` arithmetic
 * resolved outside the repo and the daemon reported "Cockpit bundle not built"
 * (the mt#1763 bundle-path-drift class).
 *
 * The cockpit daemon contract guarantees `process.cwd()` is the repo root:
 *   - the tray spawns the daemon with `current_dir(repo_root)` (mt#2282),
 *   - launchd sets `WorkingDirectory=repoPath`,
 *   - `src/cockpit/server.ts` already resolves `src/cli.ts` via `process.cwd()`.
 * So resolve from `process.cwd()` — correct whether the code runs from
 * `src/cli.ts` (source) or `dist/minsky.js` (bundle).
 *
 * `cwd` is injectable for testing.
 */
export function cockpitWebDistDir(cwd: string = process.cwd()): string {
  return path.join(cwd, "src", "cockpit", "web", "dist");
}

/** The SPA entrypoint (`index.html`) inside the web-dist dir. */
export function cockpitIndexHtml(cwd: string = process.cwd()): string {
  return path.join(cockpitWebDistDir(cwd), "index.html");
}
