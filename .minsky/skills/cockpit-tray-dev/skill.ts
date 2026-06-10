import { defineSkill, loadMarkdown } from "../../../packages/domain/src/definitions/factories";

export default defineSkill({
  name: "cockpit-tray-dev",
  description:
    "Develop, test, and ship the cockpit-tray Tauri macOS menu-bar app (cockpit-tray/**) — the native shell that supervises the cockpit daemon and hosts the in-app cockpit window (sibling to cockpit-design, which owns the web UI). Encodes the two-layer mental model (cockpit-web changes auto-rebuild via the tray's watchers, mt#2297/mt#2299; the tray's own Rust binary does NOT and needs `bun run dev` or a rebuild+reinstall), the `tauri dev` iteration loop, why a merged change is not in the running menu bar, the release-install path, auto-update (tauri-plugin-updater, mt#2201), the testing tiers (mt#2226, including that `cargo check` does not verify GUI behavior), and Tauri gotchas (external-URL webviews lose IPC, dock suppression, standalone package, supervisor model ADR-014/mt#2241). Use when working in cockpit-tray/**, testing a tray change, asking 'why don't I see my change in the menu bar', or building the harness-host ladder (mt#2230).",
  content: loadMarkdown(import.meta.dir, "content.md"),
});
