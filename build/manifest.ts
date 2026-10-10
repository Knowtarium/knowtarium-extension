import type { Environment } from "../src/environments.ts";

// The Manifest V3 file each build writes. The extension asks for `activeTab` (the current tab's link
// and title, only after the person clicks the button or presses the shortcut) and `storage`, and
// nothing else: no host permissions, no content scripts, no `tabs` or `alarms`. The API answers its
// requests through CORS for the extension's exact origin, so it needs no host permission.

/**
 * The public half of a fixed RSA key for builds that are never uploaded to a store (development and
 * staging): it pins the unpacked extension's ID, and with it the CORS origin the local and staging
 * APIs allow. Its ID is `DEVELOPMENT_EXTENSION_ID`. The private half was never kept: only a store
 * signs packages, and a store build has no `key`.
 */
export const DEVELOPMENT_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAlA6YYrSqu0stervmw82zijbXx3EMVs375rvpVoL+HUlTIKDNcYwhLosTA5f9OWS2JCdQd+u9rn78GIjw613fobGecLKcGm/bU/5kMD6SXh8MG3g0ewOq2ypP3U0IcCbXvKnz8k+nyGcwPheHHIpMGNwevrXtQ6SzspT9Q7RzqYtJ7201KanqvvqmN//PhYdLLhdU03ptV3/fJaP+lerckBdg6U644Y9LC0h8qc8uzsJj/Hds3lfVTIyyGs5L2GclyxgFII+eqzmVljtSqo7eY0EnYMRR5XhEkYc8SAHPEpMIiesnVBK27Ch5kltQzpm42SQzwwcbZX5W27OToh5tOQIDAQAB";

/** The extension ID `DEVELOPMENT_KEY` gives (`chrome-extension://<id>` is its origin). */
export const DEVELOPMENT_EXTENSION_ID = "idkngjlbfganidcddemgehcepgeeeiig";

/** libsodium runs as WebAssembly: the pages and the service worker may compile it, nothing else. */
export const CONTENT_SECURITY_POLICY = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'";

const ICONS = {
  "16": "icons/icon-16.png",
  "32": "icons/icon-32.png",
  "48": "icons/icon-48.png",
  "128": "icons/icon-128.png",
} as const;

export function buildManifest(environment: Environment, version: string): Record<string, unknown> {
  const label = environment.name === "production" ? "" : ` (${environment.name})`;
  return {
    manifest_version: 3,
    name: `Knowtarium Web Clipper${label}`,
    short_name: "Knowtarium",
    description: "Save the page you're on to your Knowtarium inbox, end-to-end encrypted.",
    version,
    minimum_chrome_version: "116",
    icons: ICONS,
    action: {
      default_title: "Save to Knowtarium",
      default_popup: "popup.html",
      default_icon: ICONS,
    },
    background: { service_worker: "background.js", type: "module" },
    permissions: ["activeTab", "storage"],
    commands: {
      _execute_action: { suggested_key: { default: "Alt+Shift+S" } },
    },
    content_security_policy: { extension_pages: CONTENT_SECURITY_POLICY },
    ...(environment.name === "production" ? {} : { key: DEVELOPMENT_KEY }),
  };
}
