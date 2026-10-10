import { describe, expect, it } from "vitest";

import { createApi, type FetchLike } from "../src/lib/api";

function recording(answer: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(answer());
  };
  return { calls, fetchImpl };
}

describe("the API client", () => {
  it("sends the protocol headers, no cookies and no redirects", async () => {
    const { calls, fetchImpl } = recording(
      () => new Response('{"status":"queued"}', { status: 201 }),
    );
    const api = createApi("https://api.test", fetchImpl);
    expect(await api.postClip("kte_x", { clipId: "clip_1", blob: "AQ" })).toEqual({
      kind: "ok",
      status: 201,
      body: { status: "queued" },
    });
    const [call] = calls;
    expect(call?.url).toBe("https://api.test/extensions/current/clips");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.credentials).toBe("omit");
    expect(call?.init.redirect).toBe("error");
    expect(call?.init.headers).toEqual({
      "Knowtarium-Protocol-Version": "2",
      "Knowtarium-Request": "1",
      Authorization: "Bearer kte_x",
      "Content-Type": "application/json",
    });
    expect(call?.init.body).toBe('{"clipId":"clip_1","blob":"AQ"}');
  });

  it("sends no request header on a GET and puts the request ID in the poll path", async () => {
    const { calls, fetchImpl } = recording(() => new Response("{}", { status: 200 }));
    const api = createApi("https://api.test", fetchImpl);
    await api.getInboxKey("kte_x");
    await api.pollConnect("cr_0abc", "secret");
    await api.revoke("kte_x");
    expect(calls[0]?.init.headers).toEqual({
      "Knowtarium-Protocol-Version": "2",
      Authorization: "Bearer kte_x",
    });
    expect(calls[1]?.url).toBe("https://api.test/connect-requests/cr_0abc/poll");
    expect(calls[2]?.init.method).toBe("DELETE");
  });

  it("reads the error code and Retry-After", async () => {
    const { fetchImpl } = recording(
      () =>
        new Response('{"error":{"code":"rate_limited","message":"x","retryAfterSeconds":9}}', {
          status: 429,
          headers: { "Retry-After": "30" },
        }),
    );
    expect(await createApi("https://api.test", fetchImpl).startConnect("0.1.0")).toEqual({
      kind: "error",
      status: 429,
      code: "rate_limited",
      error: { code: "rate_limited", message: "x", retryAfterSeconds: 9 },
      retryAfterSeconds: 30,
    });
  });

  it("reads Retry-After as an HTTP date too", async () => {
    const at = new Date(Date.now() + 90_000).toUTCString();
    const { fetchImpl } = recording(
      () =>
        new Response('{"error":{"code":"rate_limited","message":"x"}}', {
          status: 429,
          headers: { "Retry-After": at },
        }),
    );
    const result = await createApi("https://api.test", fetchImpl).getInboxKey("kte_x");
    expect(result.kind === "error" && result.retryAfterSeconds).toBeGreaterThan(80);
    expect(result.kind === "error" && result.retryAfterSeconds).toBeLessThanOrEqual(90);
  });

  it("copes with an error that isn't JSON", async () => {
    const { fetchImpl } = recording(
      () => new Response("<html>bad gateway</html>", { status: 502 }),
    );
    expect(await createApi("https://api.test", fetchImpl).getInboxKey("kte_x")).toEqual({
      kind: "error",
      status: 502,
      code: null,
      error: null,
      retryAfterSeconds: null,
    });
  });

  it("calls a request that never got an answer a network failure", async () => {
    const api = createApi("https://api.test", () =>
      Promise.reject(new TypeError("Failed to fetch")),
    );
    expect(await api.startConnect("0.1.0")).toEqual({ kind: "network" });
  });
});
