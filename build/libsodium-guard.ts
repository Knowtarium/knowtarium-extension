import { realpathSync } from "node:fs";
import { join } from "node:path";

import type { Plugin } from "vite";

// The extension bundles libsodium's standard build at exactly the version in this project's
// lockfile (libsodium-wrappers 0.8.4 over libsodium 0.8.4), never the sumo build, even though the
// SDK it links in development imports libsodium-wrappers from its own folder. The build fails when
// any other copy, or the sumo build, would end up in the bundle.

const ALLOWED = ["libsodium-wrappers@0.8.4", "libsodium@0.8.4"];

export function libsodiumGuard(root: string): Plugin {
  const store = realpathSync(join(root, "node_modules", ".pnpm"));
  const allowed = ALLOWED.map((name) => join(store, name, "node_modules"));
  const seen = new Set<string>();
  return {
    name: "knowtarium-libsodium-guard",
    load(id) {
      if (!id.includes("libsodium")) return null;
      const path = realpathSync(id.split("?")[0] ?? id);
      if (path.includes("sumo")) this.error(`the sumo build must not be bundled: ${path}`);
      if (!allowed.some((dir) => path.startsWith(dir))) {
        this.error(`libsodium from outside this project's pinned copies: ${path}`);
      }
      seen.add(path.includes("libsodium-wrappers@") ? "wrappers" : "libsodium");
      return null;
    },
    generateBundle() {
      if (seen.size !== 2) this.error("expected libsodium-wrappers and libsodium in the bundle");
    },
  };
}
