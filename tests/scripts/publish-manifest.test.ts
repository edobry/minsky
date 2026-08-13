/**
 * Publish-manifest resolvability guard (mt#3949).
 *
 * `@edobry/minsky@0.1.1` shipped with `"@minsky/domain": "workspace:*"` and
 * `"@minsky/shared": "workspace:*"` in `dependencies`. The `workspace:` protocol is
 * local-only — no registry client can resolve it — so every install outside this
 * monorepo failed before a byte of the bundle was fetched:
 *
 *     $ bun add @edobry/minsky
 *     error: @minsky/domain@workspace:* failed to resolve
 *     error: @minsky/shared@workspace:* failed to resolve
 *
 * `npm publish` does NOT rewrite the protocol (only a package manager's own publish
 * command does — `bun publish` and `pnpm publish` strip it, `npm publish` does not), and
 * the publish workflow must stay on npm's CLI for OIDC trusted publishing and provenance.
 * So the manifest itself has to be registry-safe, and nothing checked that until an
 * install was attempted from outside the repo for the first time — twenty days and two
 * published versions after the channel was declared working.
 *
 * The subject under test is the committed `package.json`, not a module's behavior: this
 * is a contract with every future installer, and the only place it can be checked before
 * a version number is burned.
 *
 * Scoped to the LOCAL-ONLY protocol classes rather than the two names that caused the
 * incident — `workspace:`, `file:` and `link:` all resolve fine in-repo and all break
 * identically once published.
 */

import { describe, test, expect } from "bun:test";
// eslint-disable-next-line custom/no-real-fs-in-tests -- reads the real committed manifest, which IS the artifact under test; there is nothing to inject, the contract is with the file on disk
import { readFileSync } from "fs";
import { join } from "path";

/** Dependency-spec prefixes that resolve locally and cannot resolve from a registry. */
const LOCAL_ONLY_PROTOCOLS = ["workspace:", "file:", "link:"] as const;

const manifest = JSON.parse(
  // eslint-disable-next-line custom/no-real-fs-in-tests -- the committed manifest IS the subject under test
  readFileSync(join(import.meta.dir, "../../package.json")).toString()
) as {
  dependencies?: Record<string, string>;
  files?: string[];
  bin?: Record<string, string>;
  module?: string;
};

/**
 * Whether `files` ships the given path — either as an exact entry or via a directory entry it
 * sits under. Negation entries (`!dist/*.map`) are ignored: they subtract from a directory
 * already listed, and no manifest path this guard checks is a source map.
 */
function shipsUnderFiles(path: string, files: string[]): boolean {
  const normalized = path.replace(/^\.\//, "");
  return files
    .filter((entry) => !entry.startsWith("!"))
    .some((entry) => {
      const normalizedEntry = entry.replace(/^\.\//, "");
      return normalized === normalizedEntry || normalized.startsWith(normalizedEntry);
    });
}

describe("published manifest resolvability (mt#3949)", () => {
  test("no `dependencies` entry uses a local-only protocol", () => {
    const offenders = Object.entries(manifest.dependencies ?? {}).filter(([, spec]) =>
      LOCAL_ONLY_PROTOCOLS.some((protocol) => spec.startsWith(protocol))
    );

    expect(offenders).toEqual([]);
  });

  test("`dependencies` is non-empty, so an empty object cannot vacuously pass the check above", () => {
    // The guard above is satisfied by deleting `dependencies` outright, which would
    // install cleanly and then fail at runtime — the bundle still resolves `ajv`,
    // `ajv-formats` and `ws` as bare specifiers. A vacuous pass is the failure mode
    // most likely to look like a fix.
    expect(Object.keys(manifest.dependencies ?? {}).length).toBeGreaterThan(0);
  });

  test("the runtime bundle the bin entry loads ships in the published file set", () => {
    // The bin entry is a thin shim: it `await import()`s `module` (dist/minsky.js), which is
    // where all the actual code lives. Shipping the shim without its target produces a package
    // that installs cleanly and dies on first run — the same shape as the vacuous-`dependencies`
    // failure guarded above. `files` covers it today via the `dist/` directory entry; a future
    // narrowing of that list would drop it silently. (PR #2803 reviewer suggestion.)
    const moduleEntry = manifest.module ?? "";
    expect(moduleEntry).not.toBe("");
    expect(shipsUnderFiles(moduleEntry, manifest.files ?? [])).toBe(true);
  });

  test("the bin entry ships in the published file set", () => {
    const binEntry = manifest.bin?.minsky ?? "";
    expect(binEntry).not.toBe("");
    expect(shipsUnderFiles(binEntry, manifest.files ?? [])).toBe(true);
  });
});
