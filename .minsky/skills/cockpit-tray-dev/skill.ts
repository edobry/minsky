import { defineSkill, loadMarkdown } from "../../../packages/domain/src/definitions/factories";

export default defineSkill({
  name: "cockpit-tray-dev",
  description:
    "Develop, test, and ship the cockpit-tray Tauri macOS menu-bar app (cockpit-tray/**). Covers the two-layer model (web changes auto-rebuild; the Rust binary does not), the dev loop, and the release-install path. Use when working in cockpit-tray/**, or asking why a merged change is not in the menu bar.",
  content: loadMarkdown(import.meta.dir, "content.md"),
});
