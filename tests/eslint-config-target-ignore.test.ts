/**
 * Regression guard for mt#2541: the ESLint flat config must ignore Rust/Cargo
 * build output (the `target/` directory glob).
 *
 * `cargo doc`/`cargo check` in cockpit-tray generate rustdoc HTML+JS under
 * `src-tauri/target/doc`. Those `.js` files are gitignored but present on disk,
 * and `src/hooks/pre-commit.ts` runs `eslint .` over the whole repo — so without
 * this ignore, ESLint lints hundreds of generated files and BLOCKS every commit
 * (observed: 307 errors, mt#2528). This test fails if a future config refactor
 * drops the ignore.
 *
 * Uses ESLint's OWN ignore resolution (`isPathIgnored`) rather than a text match
 * against eslint.config.js, so it survives any reformatting of the glob and
 * verifies the actual behavior (a target/ path is ignored), not the source text.
 */
import { describe, test, expect } from "bun:test";
import { ESLint } from "eslint";

describe("eslint.config.js ignores (mt#2541)", () => {
  test("ignores Rust/Cargo target build output", async () => {
    const eslint = new ESLint();
    // A representative path under a Rust build-output dir (need not exist on disk;
    // isPathIgnored resolves the ignore patterns, not the file).
    expect(await eslint.isPathIgnored("cockpit-tray/src-tauri/target/doc/probe.js")).toBe(true);
    // A normal source path is NOT ignored — proves the glob isn't over-broad.
    expect(await eslint.isPathIgnored("src/index.ts")).toBe(false);
  });
});
