import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { type BrowserContext, chromium, expect, type Route, test } from "@playwright/test";

import { DEVELOPMENT_EXTENSION_ID } from "../build/manifest.ts";
import { ENVIRONMENTS } from "../src/environments.ts";

// Loads the unpacked development build in Chromium. Skipped by default: set
// KNOWTARIUM_E2E_EXTENSION=smoke for the checks that answer the API themselves, or =full to also
// pair against the local sync API and web app and save a clip that ends up as a note (that run
// needs both running, a test account in KNOWTARIUM_E2E_EMAIL and KNOWTARIUM_E2E_PASSWORD, and an
// unlocked workspace). Chromium starts with a mock keychain, a basic password store and a fresh
// profile in KNOWTARIUM_E2E_TMP (or the system's temp folder), deleted afterwards.
//
// The full run depends on these parts of the web app (t-129), by accessible name:
// - /connect/extension, when signed out: fields labelled "Email" and "Password" and a button
//   named "Sign in" (any letter case); it then comes back to /connect/extension
// - /connect/extension: the extension's code shown as text (`ABCD-EFGH`), a checkbox labelled
//   "This code matches my extension" and a button named "Allow" (enabled once it is ticked)
// - after Allow, the pairing page here shows "Connected to <workspace>"
// - the web app's home (/), once the clip is filed: the clip's title "A page to keep" shown
//   as text (the note in the file tree or the inbox)
//
// The popup reads the active tab with chrome.tabs.query, which needs the activeTab grant a click
// on the toolbar button gives; a test can't click it, so the full run opens popup.html in a tab
// with chrome.tabs.query answering the test page's link and title.

const MODE = process.env["KNOWTARIUM_E2E_EXTENSION"];
const DIST = resolve(import.meta.dirname, "..", "dist");
const API = ENVIRONMENTS.development.apiOrigin;
const APP = ENVIRONMENTS.development.appOrigin;
const EXTENSION = `chrome-extension://${DEVELOPMENT_EXTENSION_ID}`;

test.skip(MODE !== "smoke" && MODE !== "full", "set KNOWTARIUM_E2E_EXTENSION=smoke or full");

let context: BrowserContext;
let profile: string;

test.beforeEach(async () => {
  profile = mkdtempSync(
    join(process.env["KNOWTARIUM_E2E_TMP"] ?? tmpdir(), "knowtarium-extension-"),
  );
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: process.env["HEADED"] === undefined,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      "--use-mock-keychain",
      "--password-store=basic",
    ],
  });
});

test.afterEach(async () => {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
});

async function serviceWorker() {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
}

const CORS = {
  "Access-Control-Allow-Origin": EXTENSION,
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Knowtarium-Protocol-Version, Knowtarium-Request",
  "Access-Control-Max-Age": "600",
};

/** Answers the API the way the design says, for the smoke checks. */
async function fakeApi(route: Route): Promise<void> {
  const request = route.request();
  if (request.method() === "OPTIONS") {
    await route.fulfill({ status: 204, headers: CORS });
    return;
  }
  const path = new URL(request.url()).pathname;
  if (request.method() === "POST" && path === "/connect-requests") {
    expect(request.headers()["knowtarium-protocol-version"]).toBe("2");
    expect(request.headers()["knowtarium-request"]).toBe("1");
    expect(request.postDataJSON()).toEqual({ client: "extension", extensionVersion: "0.1.0" });
    await route.fulfill({
      status: 201,
      headers: CORS,
      json: {
        requestId: "cr_0123456789abcdefghjkmnpqrs",
        pollSecret: "poll-secret",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        pollIntervalSeconds: 2,
      },
    });
    return;
  }
  if (path.endsWith("/poll")) {
    await route.fulfill({
      status: 200,
      headers: CORS,
      json: { status: "pending", pollIntervalSeconds: 2 },
    });
    return;
  }
  await route.fulfill({
    status: 404,
    headers: CORS,
    json: { error: { code: "not_found", message: "" } },
  });
}

test.describe("smoke", () => {
  test("loads with the fixed development ID and only its two permissions", async () => {
    const worker = await serviceWorker();
    expect(new URL(worker.url()).host).toBe(DEVELOPMENT_EXTENSION_ID);
    const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
    expect(manifest.permissions).toEqual(["activeTab", "storage"]);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
  });

  test("the popup offers to connect", async () => {
    const page = await context.newPage();
    await page.goto(`${EXTENSION}/popup.html`);
    await expect(page.getByRole("button", { name: "Connect to Knowtarium" })).toBeVisible();
  });

  test("the pairing page runs libsodium under the CSP and shows the code at once", async () => {
    const errors: string[] = [];
    await context.route(`${API}/**`, fakeApi);
    // the web app's page is answered here too: nothing reaches a local server
    await context.route(`${APP}/**`, (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<title>Knowtarium</title>" }),
    );
    // the popup's Connect button opens the page this way: a one-time nonce in session storage
    const worker = await serviceWorker();
    await worker.evaluate(() => chrome.storage.session.set({ pairNonce: "e2e-nonce" }));
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    const opened = context.waitForEvent("page");
    await page.goto(`${EXTENSION}/pair.html?start=e2e-nonce`);
    await expect(page.locator("#code")).toHaveText(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    await expect(page.getByText("Check that Knowtarium shows this code")).toBeVisible();
    const web = await opened;
    await web.waitForURL(`${APP}/connect/extension?**`);
    const url = new URL(web.url());
    expect(url.searchParams.get("request")).toBe("cr_0123456789abcdefghjkmnpqrs");
    expect(url.hash).toMatch(/^#signPublicKey=[A-Za-z0-9_-]{43}&secret=[A-Za-z0-9_-]{43}$/);
    expect(errors).toEqual([]);
  });

  test("a pairing page opened without the popup's nonce starts nothing", async () => {
    const requests: string[] = [];
    await context.route(`${API}/**`, (route) => {
      requests.push(route.request().url());
      return fakeApi(route);
    });
    const page = await context.newPage();
    await page.goto(`${EXTENSION}/pair.html?start=guessed`);
    await expect(page.getByRole("button", { name: "Connect to Knowtarium" })).toBeVisible();
    expect(requests).toEqual([]);
    expect(context.pages()).toHaveLength(2);
  });
});

test.describe("full", () => {
  test.skip(MODE !== "full", "needs the local sync API and web app: KNOWTARIUM_E2E_EXTENSION=full");

  test("pairs through the web app and saves a clip that ends up as a note", async () => {
    const email = process.env["KNOWTARIUM_E2E_EMAIL"] ?? "";
    const password = process.env["KNOWTARIUM_E2E_PASSWORD"] ?? "";
    test.skip(email === "" || password === "", "needs KNOWTARIUM_E2E_EMAIL and _PASSWORD");

    // pair: from the popup's Connect button; the extension shows the code, the web app the same
    const start = await context.newPage();
    await start.goto(`${EXTENSION}/popup.html`);
    const pairOpened = context.waitForEvent("page");
    await start.getByRole("button", { name: "Connect to Knowtarium" }).click();
    const pair = await pairOpened;
    const webOpened = context.waitForEvent("page");
    await expect(pair.locator("#code")).toHaveText(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const code = (await pair.locator("#code").textContent()) ?? "";
    const web = await webOpened;
    await web.waitForURL(`${APP}/**`);
    if (
      await web
        .getByLabel("Email")
        .isVisible()
        .catch(() => false)
    ) {
      await web.getByLabel("Email").fill(email);
      await web.getByLabel("Password").fill(password);
      await web.getByRole("button", { name: /sign in/i }).click();
    }
    await expect(web.getByText(code)).toBeVisible({ timeout: 60_000 });
    await web.getByLabel("This code matches my extension").check();
    await web.getByRole("button", { name: "Allow" }).click();
    await expect(pair.getByText(/^Connected to /)).toBeVisible({ timeout: 60_000 });

    // save the page the test serves, through the popup, with the tab it would read
    const article = { url: "https://clip.example/article", title: "A page to keep" };
    const popup = await context.newPage();
    await popup.addInitScript((tab) => {
      Object.defineProperty(chrome.tabs, "query", {
        configurable: true,
        value: () => Promise.resolve([{ ...tab, active: true }]),
      });
    }, article);
    await popup.goto(`${EXTENSION}/popup.html`);
    await expect(popup.getByLabel("Title")).toHaveValue(article.title);
    await popup.getByLabel("Note (optional)").fill("Read later");
    await popup.getByRole("button", { name: "Save" }).click();
    await expect(popup.getByText("Saved to Inbox")).toBeVisible();

    // the web app files it as a note in the inbox
    await web.goto(`${APP}/`);
    await expect(web.getByText("A page to keep")).toBeVisible({ timeout: 60_000 });
  });
});
