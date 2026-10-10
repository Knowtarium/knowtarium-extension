/** Puts a page's body markup into the test document, leaving its head (stylesheet, script) out. */
export function loadBody(html: string): void {
  const body = html.slice(html.indexOf("<body>") + "<body>".length, html.indexOf("</body>"));
  const parsed = new DOMParser().parseFromString(
    `<!doctype html><html><body>${body}</body></html>`,
    "text/html",
  );
  document.body.replaceChildren(...Array.from(parsed.body.childNodes));
}
