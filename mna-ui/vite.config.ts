import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { pdfAssets } from "./server/pdf-assets";
import { ports } from "./server/ports.mjs";

const bridge = `http://127.0.0.1:${ports.bridge}`;

export default defineConfig({
  plugins: [react(), pdfAssets()],
  server: {
    proxy: { "/api": bridge },
    watch: {
      ignored: [
        "**/.playwright-cli/**",
        "**/.screening-data/**",
        "**/.pnpm-store/**",
        "**/output/**",
      ],
    },
  },
  preview: { proxy: { "/api": bridge } },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "assistant-ui": ["@assistant-ui/react"],
          workbook: ["fflate"],
        },
      },
    },
  },
});
