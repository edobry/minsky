/**
 * Coverage guard for the Octokit bounded-timeout sweep (mt#2270).
 *
 * Every production `new Octokit(...)` construction must wire the shared
 * bounded-timeout fetch from `octokit-timeout.ts`; otherwise a hung GitHub call
 * can wedge a long-lived process (mt#2186 observed 27-38 minute requests).
 * mt#2245 fixed the github-issues backend instance; mt#2270 swept the remaining
 * clients. This test fails if a NEW `new Octokit(...)` site is added without the
 * timeout, keeping the class closed.
 *
 * This is the executable form of mt#2270's acceptance test: "Grep `new Octokit(`
 * across `packages/domain/src` and `src/`; every match either passes through the
 * shared bounded-timeout helper or is explicitly justified."
 */
/* eslint-disable custom/no-real-fs-in-tests -- scanning the shipped source tree for unbounded Octokit clients IS the point of this coverage guard; DI cannot verify what is actually on disk */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../../../..");

// Directories scanned for production Octokit construction sites.
const SCAN_DIRS = [join(REPO_ROOT, "packages/domain/src"), join(REPO_ROOT, "src")];

// Relative paths (from REPO_ROOT) explicitly exempt from the timeout
// requirement, each with a justification. Empty today — every production site
// is swept. Add an entry here (with a comment) only for a genuinely test-only
// or otherwise-justified client.
const ALLOWLIST = new Set<string>([]);

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      out.push(...collectTsFiles(full));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test.tsx") &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Extract the balanced `(...)` argument text following each `new Octokit` in
 * `src`. Comment mentions like `// prefer new Octokit` are ignored because they
 * are not followed by an opening paren.
 */
function octokitConstructorArgs(src: string): string[] {
  const args: string[] = [];
  const marker = "new Octokit";
  let idx = src.indexOf(marker);
  while (idx !== -1) {
    let i = idx + marker.length;
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] === "(") {
      let depth = 0;
      const start = i;
      for (; i < src.length; i++) {
        const ch = src[i];
        if (ch === "(") depth++;
        else if (ch === ")") {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
      }
      args.push(src.slice(start, i));
    }
    idx = src.indexOf(marker, idx + marker.length);
  }
  return args;
}

describe("Octokit bounded-timeout coverage (mt#2270)", () => {
  const files = SCAN_DIRS.flatMap(collectTsFiles);

  test("scan found production Octokit construction sites", () => {
    const withOctokit = files.filter((f) => readFileSync(f, "utf8").includes("new Octokit"));
    // Sanity: if this drops to zero the scan is mis-configured (wrong root).
    expect(withOctokit.length).toBeGreaterThan(0);
  });

  test("every production `new Octokit(...)` wires createTimeoutFetch", () => {
    const violations: string[] = [];
    for (const file of files) {
      const rel = file.slice(REPO_ROOT.length + 1);
      if (ALLOWLIST.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      if (!src.includes("new Octokit")) continue;
      for (const argText of octokitConstructorArgs(src)) {
        if (!argText.includes("createTimeoutFetch")) {
          violations.push(`${rel}: ${argText.replace(/\s+/g, " ")}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
