import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/cockpit/web",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Long-cached vendor chunks. Page chunks are produced automatically from
    // React.lazy() dynamic imports in App.tsx; this manualChunks map only
    // governs the shared vendor split. Keep this list tight — over-splitting
    // adds HTTP request overhead without proportional cache benefit.
    rollupOptions: {
      output: {
        manualChunks: {
          "react-vendor": ["react", "react-dom"],
          router: ["react-router-dom"],
          tanstack: ["@tanstack/react-query"],
          icons: ["lucide-react"],
        },
      },
    },
  },
  server: { proxy: { "/api": "http://localhost:3737" } },
});
