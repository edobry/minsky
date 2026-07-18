#!/usr/bin/env bun
// Regenerates services/site/public/og-cover.png from cover.html (mt#2908).
//
// Not wired into the build — this is a maintenance tool for when brand tokens
// or the cover composition change, per minsky-reviewer[bot]'s PR #2047 review
// (asset provenance/reproducibility).
//
// Usage:
//   bun add -d playwright-core          # once, if not already available
//   bunx playwright install chromium    # once, if the browser binary isn't cached
//   bun services/site/tools/og-cover/generate.ts
//
// Output: services/site/public/og-cover.png (1200x630, deviceScaleFactor 1 —
// OG images don't benefit from 2x, and the file should stay well under 300KB).
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(dir, "cover.html");
const outPath = process.argv[2] ?? path.join(dir, "../../public/og-cover.png");

// playwright-core is an optional, not-a-dependency tool import (see try/catch below) —
// there's no installed type declaration to reference when it's absent.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let chromium: any;
try {
  ({ chromium } = await import("playwright-core"));
} catch {
  // eslint-disable-next-line custom/no-raw-console -- operator CLI diagnostic; not build-wired (see eslint.config.js scripts/*.ts exemption rationale)
  console.error(
    "playwright-core is not resolvable from this script.\n" +
      "Install it locally first: bun add -d playwright-core\n" +
      "Then ensure a Chromium binary is cached: bunx playwright install chromium"
  );
  process.exit(1);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  });
  await page.goto(`file://${htmlPath}`);
  await page.waitForTimeout(100);
  await page.screenshot({ path: outPath, clip: { x: 0, y: 0, width: 1200, height: 630 } });

  const { size } = statSync(outPath);
  const budget = 300 * 1024;
  // eslint-disable-next-line custom/no-raw-console -- operator CLI diagnostic; not build-wired (see eslint.config.js scripts/*.ts exemption rationale)
  console.log(`Wrote ${outPath} (${size} bytes)`);
  if (size > budget) {
    // eslint-disable-next-line custom/no-raw-console -- same operator-script rationale as above
    console.warn(`WARNING: exceeds the ${budget}-byte OG-image budget.`);
  }
} finally {
  await browser.close();
}
