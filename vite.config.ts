import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineConfig, type Plugin } from "vite";

import { libsodiumGuard } from "./build/libsodium-guard.ts";
import { buildManifest } from "./build/manifest.ts";
import { type Environment, environmentFor } from "./src/environments.ts";

const here = import.meta.dirname;
const { version } = JSON.parse(readFileSync(resolve(here, "package.json"), "utf8")) as {
  version: string;
};

/** Writes manifest.json for the build's environment next to the pages. */
function manifest(environment: Environment): Plugin {
  return {
    name: "knowtarium-manifest",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "manifest.json",
        source: `${JSON.stringify(buildManifest(environment, version), null, 2)}\n`,
      });
    },
  };
}

// Three entries: the popup, the pairing page and the service worker (which sends the queue when the
// browser starts). Fixed names for what the manifest names, hashed names for shared chunks. No
// source maps and no inline scripts, so the extension pages' CSP stays `script-src 'self'`.
export default defineConfig(({ mode }) => {
  const environment = environmentFor(mode);
  return {
    root: resolve(here, "src"),
    publicDir: resolve(here, "public"),
    base: "./",
    define: { __KNOWTARIUM_ENVIRONMENT__: JSON.stringify(environment) },
    // libsodium-wrappers comes from this project's lockfile (pinned to 0.8.4), even where the
    // linked SDK imports it from its own folder
    resolve: { dedupe: ["libsodium-wrappers"] },
    build: {
      outDir: resolve(here, "dist"),
      emptyOutDir: true,
      target: "chrome116",
      sourcemap: false,
      modulePreload: false,
      reportCompressedSize: false,
      rollupOptions: {
        input: {
          popup: resolve(here, "src/popup.html"),
          pair: resolve(here, "src/pair.html"),
          background: resolve(here, "src/background.ts"),
        },
        output: {
          entryFileNames: "[name].js",
          chunkFileNames: "chunks/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },
    plugins: [manifest(environment), libsodiumGuard(here)],
  };
});
