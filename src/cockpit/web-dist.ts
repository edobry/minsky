import fs from "fs";
import path from "path";

/**
 * Bundle-aware resolution of the cockpit web-dist directory (mt#2283).
 *
 * `bun run cockpit:build` writes the SPA to `<repo>/src/cockpit/web/dist`.
 * Computing this path via `import.meta.url` arithmetic broke when the CLI ran
 * from the bundled `dist/minsky.js`: `import.meta.url` points into `<repo>/dist`,
 * so the old `path.join(__dirname, "..", "..", "cockpit", "web", "dist")`
 * resolved outside the repo and the daemon reported "Cockpit bundle not built"
 * (the mt#1763 bundle-path-drift class).
 *
 * Resolution finds the repo root by looking for a directory that contains
 * `src/cockpit/web`, checking (in order): `process.cwd()` — the daemon's
 * cwd=repo-root contract (tray `current_dir(repo_root)` mt#2282; launchd
 * `WorkingDirectory`; `server.ts` already resolves `src/cli.ts` via cwd) — then
 * walking up from cwd and from the calling module's directory. The module-dir
 * walk is the fallback for a non-repo cwd: from a source location
 * (`<repo>/src/cockpit/...`) or a bundle location (`<repo>/dist`) it ascends to
 * `<repo>` regardless of cwd.
 */
export type ExistsFn = (p: string) => boolean;

const realExists: ExistsFn = (p) => fs.existsSync(p);

const MAX_ASCEND = 12;

/** Walk up from each start dir; return the first that contains `src/cockpit/web`. */
export function findRepoRoot(
  startDirs: string[],
  exists: ExistsFn = realExists
): string | undefined {
  for (const start of startDirs) {
    if (!start) continue;
    let dir = start;
    for (let i = 0; i < MAX_ASCEND; i++) {
      if (exists(path.join(dir, "src", "cockpit", "web"))) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

/**
 * The cockpit web-dist directory. `moduleDir` should be the caller's
 * `path.dirname(fileURLToPath(import.meta.url))` so resolution can fall back to a
 * module-relative walk when cwd is not the repo root. Falls back to a cwd-based
 * path (for a clear "not built" message) when no repo root is found.
 */
export function cockpitWebDistDir(moduleDir?: string, exists: ExistsFn = realExists): string {
  const starts = [process.cwd(), ...(moduleDir ? [moduleDir] : [])];
  const root = findRepoRoot(starts, exists) ?? process.cwd();
  return path.join(root, "src", "cockpit", "web", "dist");
}

/** The SPA entrypoint (`index.html`) inside the web-dist dir. */
export function cockpitIndexHtml(moduleDir?: string, exists: ExistsFn = realExists): string {
  return path.join(cockpitWebDistDir(moduleDir, exists), "index.html");
}
