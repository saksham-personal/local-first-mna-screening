import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { pdfAssets } from "./server/pdf-assets";

export default defineConfig({
  plugins: [react(), pdfAssets()],
  server: {
    proxy: { "/api": "http://127.0.0.1:7319" },
    watch: {
      ignored: [
        "**/.playwright-cli/**",
        "**/.screening-data/**",
        "**/.pnpm-store/**",
        "**/output/**",
      ],
    },
  },
  preview: { proxy: { "/api": "http://127.0.0.1:7319" } },
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
