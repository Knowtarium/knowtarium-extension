import { describe, expect, it } from "vitest";

import { buildManifest, CONTENT_SECURITY_POLICY, DEVELOPMENT_KEY } from "../build/manifest";
import { ENVIRONMENTS, environmentFor } from "../src/environments";

describe("the manifest", () => {
  it("asks for activeTab and storage only", () => {
    for (const environment of Object.values(ENVIRONMENTS)) {
      const manifest = buildManifest(environment, "0.1.0");
      expect(manifest["manifest_version"]).toBe(3);
      expect(manifest["permissions"]).toEqual(["activeTab", "storage"]);
      for (const key of [
        "host_permissions",
        "optional_permissions",
        "optional_host_permissions",
        "content_scripts",
        "externally_connectable",
        "web_accessible_resources",
      ]) {
        expect(manifest).not.toHaveProperty(key);
      }
    }
  });

  it("lets the pages compile WebAssembly and nothing else", () => {
    const manifest = buildManifest(ENVIRONMENTS.production, "0.1.0");
    expect(manifest["content_security_policy"]).toEqual({
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    });
    expect(CONTENT_SECURITY_POLICY).not.toContain(" 'unsafe-eval'");
  });

  it("opens the popup with Alt+Shift+S", () => {
    const manifest = buildManifest(ENVIRONMENTS.production, "0.1.0");
    expect(manifest["commands"]).toEqual({
      _execute_action: { suggested_key: { default: "Alt+Shift+S" } },
    });
    expect(manifest["action"]).toMatchObject({ default_popup: "popup.html" });
    expect(manifest["background"]).toEqual({ service_worker: "background.js", type: "module" });
  });

  it("carries the fixed key in builds that never reach a store only", () => {
    expect(buildManifest(ENVIRONMENTS.production, "0.1.0")).not.toHaveProperty("key");
    expect(buildManifest(ENVIRONMENTS.development, "0.1.0")["key"]).toBe(DEVELOPMENT_KEY);
    expect(buildManifest(ENVIRONMENTS.staging, "0.1.0")["key"]).toBe(DEVELOPMENT_KEY);
  });

  it("points each environment at its own API and web app", () => {
    expect(environmentFor("development")).toEqual({
      name: "development",
      apiOrigin: "http://localhost:8790",
      appOrigin: "http://localhost:3005",
    });
    expect(environmentFor("production").apiOrigin).toBe("https://api.knowtarium.com");
    expect(environmentFor("production").appOrigin).toBe("https://app.knowtarium.com");
    expect(environmentFor("staging").apiOrigin).toBe("https://api-staging.knowtarium.com");
    expect(() => environmentFor("test")).toThrow();
  });
});
