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

const SITE_URL = process.env.SITE_URL ?? "https://minsky.dev";
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
