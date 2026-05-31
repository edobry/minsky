#!/usr/bin/env bun
/**
 * Generate icon assets from `assets/icon/minsky-icon.svg`.
 *
 * Outputs:
 * - `assets/icon/png/{16,32,64,128,256,512,1024}.png` — multi-size PNG set
 * - `assets/icon/social-preview.png` — 1280×640 social-preview banner (README header + GitHub repo social preview)
 * - `cockpit-tray/src-tauri/icons/{32x32,128x128,128x128@2x,icon}.png` — Tauri bundle icons
 * - `cockpit-tray/src-tauri/icons/icon.icns` — macOS app icon (skipped on non-macOS)
 * - `cockpit-tray/src-tauri/icons/tray.png` and `tray@2x.png` — menu bar tray icons (template)
 *
 * Requires:
 * - `rsvg-convert` (librsvg) — `brew install librsvg` on macOS
 * - `iconutil` (built-in on macOS; iconutil-dependent outputs are skipped on non-macOS)
 * - For the social-preview banner: **Geist** and **JetBrains Mono** fonts installed
 *   system-wide. The banner SVG (`assets/icon/social-preview.svg`) references both;
 *   rsvg-convert will silently fall back to other fonts if these are missing, producing
 *   a non-deterministic PNG. The script verifies their presence via `fc-list` and errors
 *   clearly if they are absent. Install via Google Fonts (Geist) and JetBrains
 *   (JetBrains Mono). The committed `assets/icon/social-preview.png` is the
 *   canonical render; regeneration requires the same fonts to match it.
 *
 * Run with: `bun scripts/generate-icons.ts` or `bun run icons:generate`.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "bun";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceColor = join(repoRoot, "assets/icon/minsky-icon.svg");
const sourceTemplate = join(repoRoot, "assets/icon/minsky-icon-template.svg");
const sourceSocialPreview = join(repoRoot, "assets/icon/social-preview.svg");

const pngDir = join(repoRoot, "assets/icon/png");
const tauriIconsDir = join(repoRoot, "cockpit-tray/src-tauri/icons");
const iconsetDir = join(tauriIconsDir, "icon.iconset");

// Preflight: required tools + fonts
async function whichOk(cmd: string): Promise<boolean> {
  const result = await $`which ${cmd}`.nothrow().quiet();
  return result.exitCode === 0;
}

async function fontInstalled(name: string): Promise<boolean> {
  const result = await $`fc-list`.nothrow().quiet();
  if (result.exitCode !== 0) return false;
  return result.stdout.toString().toLowerCase().includes(name.toLowerCase());
}

const isMacOS = process.platform === "darwin";

if (!(await whichOk("rsvg-convert"))) {
  console.error(
    "✗ rsvg-convert not found on PATH. Install with `brew install librsvg` (macOS) or `apt install librsvg2-bin` (Linux)."
  );
  process.exit(1);
}

if (isMacOS && !(await whichOk("iconutil"))) {
  console.error("✗ iconutil not found on PATH (macOS expected to ship it built-in).");
  process.exit(1);
}

if (!(await whichOk("fc-list"))) {
  console.error(
    "✗ fc-list not found on PATH — required for font preflight. Install fontconfig (`brew install fontconfig` on macOS)."
  );
  process.exit(1);
}

const missingFonts: string[] = [];
if (!(await fontInstalled("Geist"))) missingFonts.push("Geist");
if (!(await fontInstalled("JetBrains Mono"))) missingFonts.push("JetBrains Mono");
if (missingFonts.length > 0) {
  console.error(
    `✗ Required font(s) missing: ${missingFonts.join(", ")}. The social-preview banner SVG references these; rsvg-convert would silently fall back, producing a non-deterministic PNG.`
  );
  console.error(
    "  Install Geist from https://vercel.com/font and JetBrains Mono from https://www.jetbrains.com/lp/mono/."
  );
  process.exit(1);
}

mkdirSync(pngDir, { recursive: true });
mkdirSync(tauriIconsDir, { recursive: true });

async function rsvg(input: string, output: string, size: number): Promise<void> {
  await $`rsvg-convert -w ${size} -h ${size} ${input} -o ${output}`;
}

async function rsvgRect(
  input: string,
  output: string,
  width: number,
  height: number
): Promise<void> {
  await $`rsvg-convert -w ${width} -h ${height} ${input} -o ${output}`;
}

// Generic multi-size PNG set
const pngSizes = [16, 32, 64, 128, 256, 512, 1024];
for (const size of pngSizes) {
  const out = join(pngDir, `${size}.png`);
  await rsvg(sourceColor, out, size);
  console.log(`✓ ${out}`);
}

// Tauri bundle icons
await rsvg(sourceColor, join(tauriIconsDir, "32x32.png"), 32);
await rsvg(sourceColor, join(tauriIconsDir, "128x128.png"), 128);
await rsvg(sourceColor, join(tauriIconsDir, "128x128@2x.png"), 256);
await rsvg(sourceColor, join(tauriIconsDir, "icon.png"), 1024);
console.log("✓ Tauri bundle PNGs");

// Tray icons — use the template (currentColor) variant so macOS can tint.
// rsvg renders currentColor as black, which is what macOS template images need.
await rsvg(sourceTemplate, join(tauriIconsDir, "tray.png"), 22);
await rsvg(sourceTemplate, join(tauriIconsDir, "tray@2x.png"), 44);
console.log("✓ Tray template icons");

// macOS .icns via iconutil — skipped on non-macOS
if (isMacOS) {
  rmSync(iconsetDir, { recursive: true, force: true });
  mkdirSync(iconsetDir, { recursive: true });
  const icnsSizes: Array<[number, string]> = [
    [16, "icon_16x16.png"],
    [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],
    [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"],
    [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"],
    [1024, "icon_512x512@2x.png"],
  ];
  for (const [size, name] of icnsSizes) {
    await rsvg(sourceColor, join(iconsetDir, name), size);
  }
  await $`iconutil -c icns ${iconsetDir} -o ${join(tauriIconsDir, "icon.icns")}`;
  rmSync(iconsetDir, { recursive: true, force: true });
  console.log(`✓ ${join(tauriIconsDir, "icon.icns")}`);
} else {
  console.log("⚠ iconutil is macOS-only; skipping icon.icns generation on this platform.");
}

// Social-preview banner (1280×640) — used as README header and GitHub repo social preview.
// Font preflight above ensures Geist and JetBrains Mono are installed; rsvg-convert renders
// with those fonts deterministically when present.
await rsvgRect(sourceSocialPreview, join(repoRoot, "assets/icon/social-preview.png"), 1280, 640);
console.log(`✓ ${join(repoRoot, "assets/icon/social-preview.png")}`);

console.log("\nAll icons generated.");
