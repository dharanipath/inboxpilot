import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const API = process.env.API_URL ?? "http://localhost:4000";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 5173,
    strictPort: true,
    // same-origin /api: cookies, SSE and CSRF Origin checks all just work in dev
    proxy: { "/api": { target: API, changeOrigin: false } },
  },
  build: {
    rollupOptions: {
      output: {
        // vendor code changes rarely: separate chunks stay cached across app releases
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          data: ["@tanstack/react-query", "zustand"],
          ui: [
            "framer-motion",
            "@radix-ui/react-dialog",
            "@radix-ui/react-dropdown-menu",
            "@radix-ui/react-popover",
            "@radix-ui/react-tooltip",
          ],
        },
      },
    },
  },
  preview: { port: 5173, strictPort: true, proxy: { "/api": { target: API } } },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/main.tsx", "src/test/**", "src/**/*.test.{ts,tsx}", "src/components/ui/**"],
      reporter: ["text-summary", "text"],
    },
  },
});
