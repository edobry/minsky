import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";

const SITE_URL = process.env.SITE_URL ?? "https://minsky.dev";
const PORT = Number(process.env.PORT ?? 4321);

export default defineConfig({
  site: SITE_URL,
  output: "static",
  trailingSlash: "never",
  integrations: [react(), sitemap()],
  vite: {
    // @tailwindcss/vite ships its own Vite types, which skew from Astro's
    // bundled Vite (Plugin<any>[] vs PluginOption). The plugin is runtime-correct;
    // cast to satisfy the typecheck without deduping Vite across the monorepo.
    plugins: [tailwindcss() as never],
  },
  server: {
    port: PORT,
    host: "0.0.0.0",
  },
});
