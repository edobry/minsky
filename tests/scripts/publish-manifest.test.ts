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
};

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

  test("the bin entry ships in the published file set", () => {
    const binEntry = manifest.bin?.minsky ?? "";
    expect(binEntry).not.toBe("");

    // `files` lists the bin entry either exactly or via the directory it sits in.
    const normalized = binEntry.replace(/^\.\//, "");
    const shipped = (manifest.files ?? []).some(
      (entry) => normalized === entry.replace(/^\.\//, "") || normalized.startsWith(entry)
    );
    expect(shipped).toBe(true);
  });
});
