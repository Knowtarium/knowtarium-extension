import js from "@eslint/js";
import prettier from "eslint-config-prettier/flat";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

// The extension is write-only: it may seal and sign, never open a clip, a note or a workspace key.
// So its code imports only knowtarium/clip (which can open nothing but the pairing payload), runs
// on the standard libsodium build (never the sumo one), and never parses text as HTML.
const otherKnowtariumEntries = {
  regex: "^knowtarium(?!/clip$)",
  message: "The extension imports only knowtarium/clip, which has no function that opens a clip.",
};
const libsodiumImports = {
  regex: "^libsodium",
  message: "libsodium comes through knowtarium/clip only (the standard build, pinned).",
};
const nodeImports = {
  regex: "^node:|^(fs|path|os|child_process|crypto|stream|buffer|url|util|process)(/.*)?$",
  message: "Extension code runs in the browser: no Node built-ins.",
};
const noHtmlParsing = [
  {
    selector: "AssignmentExpression[left.property.name=/^(innerHTML|outerHTML)$/]",
    message: "Set textContent or build elements: nothing is ever parsed as HTML.",
  },
  {
    selector: "CallExpression[callee.property.name=/^(insertAdjacentHTML|write|writeln)$/]",
    message: "Set textContent or build elements: nothing is ever parsed as HTML.",
  },
];

export default defineConfig(
  globalIgnores(["**/dist/", "**/release/", "**/coverage/", "test-results/", "playwright-report/"]),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.node.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // the build scripts run in Node
    files: ["scripts/**"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", Buffer: "readonly" },
    },
  },
  {
    files: ["src/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [otherKnowtariumEntries, libsodiumImports, nodeImports] },
      ],
      "no-restricted-syntax": ["error", ...noHtmlParsing],
      "no-restricted-globals": [
        "error",
        { name: "eval", message: "The extension pages' CSP allows no eval." },
      ],
    },
  },
  {
    // a test plays the web app's side too (the owner's keys, sealing the pairing payload, opening a
    // clip), which knowtarium/crypto and knowtarium/client do
    files: ["test/**"],
    rules: {
      "no-restricted-syntax": ["error", ...noHtmlParsing.slice(1)],
    },
  },
  prettier,
);
