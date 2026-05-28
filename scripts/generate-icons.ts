#!/usr/bin/env bun
/**
 * Generate icon assets from `assets/icon/minsky-icon.svg`.
 *
 * Outputs:
 * - `assets/icon/png/{16,32,64,128,256,512,1024}.png` — multi-size PNG set
 * - `cockpit-tray/src-tauri/icons/{32x32,128x128,128x128@2x,icon}.png` — Tauri bundle icons
 * - `cockpit-tray/src-tauri/icons/icon.icns` — macOS app icon
 * - `cockpit-tray/src-tauri/icons/tray.png` and `tray@2x.png` — menu bar tray icons (template)
 *
 * Requires: `rsvg-convert` (librsvg), `iconutil` (macOS).
 *
 * Run with: `bun scripts/generate-icons.ts` or `bun run icons:generate`.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const repoRoot = new URL("..", import.meta.url).pathname;
const sourceColor = join(repoRoot, "assets/icon/minsky-icon.svg");
const sourceTemplate = join(repoRoot, "assets/icon/minsky-icon-template.svg");

const pngDir = join(repoRoot, "assets/icon/png");
const tauriIconsDir = join(repoRoot, "cockpit-tray/src-tauri/icons");
const iconsetDir = join(tauriIconsDir, "icon.iconset");

mkdirSync(pngDir, { recursive: true });
mkdirSync(tauriIconsDir, { recursive: true });

async function rsvg(input: string, output: string, size: number): Promise<void> {
  await $`rsvg-convert -w ${size} -h ${size} ${input} -o ${output}`;
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

// macOS .icns via iconutil
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

console.log("\nAll icons generated.");
