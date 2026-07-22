/**
 * Regression guard for mt#2541: the ESLint flat config must ignore Rust/Cargo
 * build output (the `target/` directory glob).
 *
 * `cargo doc`/`cargo check` in cockpit-tray generate rustdoc HTML+JS under
 * `src-tauri/target/doc`. Those `.js` files are gitignored but present on disk,
 * and `src/hooks/pre-commit.ts` runs `eslint .` over the whole repo — so without
 * this ignore, ESLint lints hundreds of generated files and BLOCKS every commit
 * (observed: 307 errors, mt#2528). This test fails if a future config refactor
 * drops the ignore. Text-based (not an import of eslint.config.js) so it stays
 * cheap and free of the config's custom-rule import graph.
 */
/* eslint-disable custom/no-real-fs-in-tests -- this guard reads the repo's real eslint.config.js by design, not a test fixture */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

describe("eslint.config.js ignores (mt#2541)", () => {
  test("ignores Rust/Cargo build output", () => {
    const config = readFileSync(join(import.meta.dir, "..", "eslint.config.js"), "utf8");
    expect(config).toContain('"**/target/**"');
  });
});
