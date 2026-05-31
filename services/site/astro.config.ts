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

const PORT = Number(process.env.PORT ?? 4321);
// In production, default to the real Railway serving URL; in dev/preview default to
// localhost so sitemap/canonical URLs don't leak the prod domain into local builds.
// Custom marketing domain undecided (mt#2046); `minsky.dev` is third-party-owned (mt#2193).
// Infra (Pulumi) sets SITE_URL explicitly in production regardless.
const DEFAULT_SITE_URL =
  process.env.NODE_ENV === "production"
    ? "https://minsky-site-production.up.railway.app"
    : `http://localhost:${PORT}`;
const SITE_URL = process.env.SITE_URL ?? DEFAULT_SITE_URL;

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
