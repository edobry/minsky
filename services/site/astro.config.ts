import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import type { AstroUserConfig } from "astro";

// @tailwindcss/vite resolves a different Vite copy than Astro's bundled Vite,
// so their Plugin/PluginOption types have distinct identities. Cast to Astro's
// own vite-plugins type (derived from AstroUserConfig) to bridge the skew using
// the correct type identity rather than a bottom (`never`/`any`) cast.
type VitePlugins = NonNullable<NonNullable<AstroUserConfig["vite"]>["plugins"]>;

// Default is the real Railway serving URL. The custom marketing domain is
// undecided (see mt#2046 brand-name exploration); do NOT default this to a
// domain we do not control. `minsky.dev` is owned by a third party (verified
// 2026-05-31) — see mt#2193 (deploy-domain ownership guard).
const SITE_URL = process.env.SITE_URL ?? "https://minsky-site-production.up.railway.app";
const PORT = Number(process.env.PORT ?? 4321);

export default defineConfig({
  site: SITE_URL,
  output: "static",
  trailingSlash: "never",
  integrations: [react(), sitemap()],
  vite: {
    plugins: [tailwindcss()] as VitePlugins,
  },
  server: {
    port: PORT,
    host: "0.0.0.0",
  },
});
