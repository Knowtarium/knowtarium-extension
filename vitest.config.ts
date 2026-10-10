import { defineConfig } from "vitest/config";

import { ENVIRONMENTS } from "./src/environments.ts";

export default defineConfig({
  define: { __KNOWTARIUM_ENVIRONMENT__: JSON.stringify(ENVIRONMENTS.development) },
  resolve: { dedupe: ["libsodium-wrappers"] },
  test: {
    // the popup and the pairing page run against their real markup
    projects: [
      {
        extends: true,
        test: { name: "node", include: ["test/**/*.test.ts"], exclude: ["test/**/*.dom.test.ts"] },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "happy-dom",
          include: ["test/**/*.dom.test.ts"],
          // the pages' markup only: no stylesheet, script or other request leaves the test
          environmentOptions: {
            happyDOM: {
              settings: {
                disableCSSFileLoading: true,
                disableJavaScriptFileLoading: true,
                disableJavaScriptEvaluation: true,
                navigation: { disableMainFrameNavigation: true, disableChildFrameNavigation: true },
              },
            },
          },
        },
      },
    ],
  },
});
