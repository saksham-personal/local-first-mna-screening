import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";

const packageRoot = dirname(
  createRequire(import.meta.url).resolve("pdfjs-dist/package.json"),
);
const folders = ["cmaps", "standard_fonts", "wasm"];

/** PDF fonts, maps, and image decoders remain local in dev and production. */
export function pdfAssets(): Plugin {
  return {
    name: "local-pdf-assets",
    configureServer(server) {
      server.middlewares.use("/pdf-assets/", (req, res, next) => {
        const match = /^\/([a-z_]+)\/([A-Za-z0-9_.-]+)$/.exec(
          (req.url ?? "").split("?")[0],
        );
        if (!match || !folders.includes(match[1])) return next();
        void readFile(join(packageRoot, match[1], match[2]))
          .then((bytes) => {
            res.setHeader(
              "Content-Type",
              match[2].endsWith(".wasm")
                ? "application/wasm"
                : match[2].endsWith(".js")
                  ? "text/javascript"
                  : "application/octet-stream",
            );
            res.setHeader("Cache-Control", "public, max-age=3600");
            res.end(bytes);
          })
          .catch(() => {
            res.statusCode = 404;
            res.end("PDF asset not found");
          });
      });
    },
    async generateBundle() {
      for (const folder of folders) {
        for (const entry of await readdir(join(packageRoot, folder), {
          withFileTypes: true,
        })) {
          if (!entry.isFile()) continue;
          this.emitFile({
            type: "asset",
            fileName: `pdf-assets/${folder}/${entry.name}`,
            source: await readFile(join(packageRoot, folder, entry.name)),
          });
        }
      }
    },
  };
}
